const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');
const { promisify } = require('util');
const zlib = require('zlib');

const gzip = promisify(zlib.gzip);

initializeApp({
  databaseURL: 'https://service-schedule-2c481-default-rtdb.asia-southeast1.firebasedatabase.app',
  storageBucket: 'service-schedule-2c481.firebasestorage.app',
});

const BACKUP_PREFIX = 'db-backups/';
const RETENTION_DAYS = 60;

exports.scheduledBackup = onSchedule(
  {
    schedule: '0 2 * * *',        // 2:00 AM every night
    timeZone: 'Asia/Kuala_Lumpur',
    memory: '512MiB',
    timeoutSeconds: 300,
    region: 'asia-southeast1',    // Singapore — closest to Malaysia
  },
  async () => {
    const now = new Date();
    const tag = now.toISOString().slice(0, 19).replace(/:/g, '-');
    const fileName = `${BACKUP_PREFIX}backup-${tag}.json.gz`;

    // 1. Read entire Realtime Database
    const snap = await getDatabase().ref('/').once('value');
    const data = snap.val();

    if (!data) {
      console.log('Database is empty — skipping backup');
      return;
    }

    // 2. gzip-compress and upload to Cloud Storage
    const compressed = await gzip(Buffer.from(JSON.stringify(data), 'utf8'));
    const bucket = getStorage().bucket();

    await bucket.file(fileName).save(compressed, {
      metadata: {
        contentType: 'application/json',
        contentEncoding: 'gzip',
        metadata: { backupDate: now.toISOString() },
      },
    });

    const sizeKB = (compressed.length / 1024).toFixed(1);
    console.log(`Backup saved: gs://${bucket.name}/${fileName} (${sizeKB} KB)`);

    // 3. Delete backups older than 60 days
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const [files] = await bucket.getFiles({ prefix: BACKUP_PREFIX });
    const expired = files.filter(f => new Date(f.metadata.timeCreated) < cutoff);

    if (expired.length > 0) {
      await Promise.all(expired.map(f => f.delete()));
      console.log(`Purged ${expired.length} backup(s) older than ${RETENTION_DAYS} days`);
    }
  }
);

// ---------------------------------------------------------------------------
// Maintenance contract reminders
// Runs every morning. For each active contract whose next service is due within
// REMIND_DAYS_BEFORE days (and has no next visit scheduled yet), Telegram every
// admin and drop an in-app Inbox notification. Overdue contracts are nudged again
// weekly until a visit is scheduled.
// ---------------------------------------------------------------------------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;   // @IHTServiceBot — set in functions/.env (not committed)
const REMIND_DAYS_BEFORE = 14;
const OVERDUE_NUDGE_DAYS = 7;

function todayISO_MY() {
  // YYYY-MM-DD in Malaysia time regardless of the function's runtime TZ
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}
function fmtISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
async function sendTelegram(chatId, text) {
  if (!TG_TOKEN) { console.warn('TELEGRAM_BOT_TOKEN not set — skipping Telegram'); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.warn('Telegram send failed', chatId, e.message);
  }
}

exports.maintenanceReminder = onSchedule(
  {
    schedule: '0 8 * * *',        // 8:00 AM every morning
    timeZone: 'Asia/Kuala_Lumpur',
    memory: '256MiB',
    timeoutSeconds: 120,
    region: 'asia-southeast1',
  },
  async () => {
    const db = getDatabase();
    const [contractsSnap, usersSnap] = await Promise.all([
      db.ref('maintenanceContracts').once('value'),
      db.ref('users').once('value'),
    ]);
    const contracts = contractsSnap.val() || {};
    const users = usersSnap.val() || {};
    const admins = Object.entries(users).filter(([, u]) => u && u.role === 'admin');
    if (!admins.length) { console.log('No admins — nothing to notify'); return; }

    const today = todayISO_MY();
    const now = Date.now();
    let sent = 0;

    for (const [id, c] of Object.entries(contracts)) {
      if (!c || c.active === false || !c.nextDue || c.nextJobDay) continue;
      const days = daysBetween(today, c.nextDue);
      if (days > REMIND_DAYS_BEFORE) continue;

      const isOverdue = days < 0;
      const firstReminderPending = c.reminderSentFor !== c.nextDue;
      const nudgeDue = isOverdue && (!c.overdueNudgedAt || now - c.overdueNudgedAt >= OVERDUE_NUDGE_DAYS * 86400000);
      if (!firstReminderPending && !nudgeDue) continue;

      const when = isOverdue
        ? `⚠️ <b>OVERDUE by ${-days} day${days === -1 ? '' : 's'}</b>`
        : days === 0 ? '📅 <b>Due today</b>' : `📅 Due in <b>${days} day${days === 1 ? '' : 's'}</b>`;
      const text =
        `🔧 <b>Maintenance Due</b>\n` +
        `👤 <b>${c.customer || 'Customer'}</b>` +
        (c.address ? `\n📍 ${c.address}` : '') +
        (c.contact ? `\n📞 ${c.contact}` : '') +
        (c.salesman ? `\n🧑‍💼 ${c.salesman}` : '') +
        `\n🔁 Every ${c.intervalMonths} months · Last service ${c.lastServiceDate ? fmtISO(c.lastServiceDate) : '—'}` +
        `\n${when} — ${fmtISO(c.nextDue)}` +
        `\n\nOpen the app → 🔧 Maintenance → Schedule visit.`;

      const notif = {
        type: 'maintenance', contractId: id,
        customer: c.customer || 'Maintenance',
        fromName: 'Maintenance Reminder',
        preview: (isOverdue ? 'OVERDUE — ' : 'Due ') + fmtISO(c.nextDue) + ' (every ' + c.intervalMonths + ' months)',
        ts: now, read: false,
      };
      const key = 'mt_' + id + '_' + now;
      const chatIds = new Set();
      const writes = [];
      for (const [uid, u] of admins) {
        writes.push(db.ref(`notifications/${uid}/${key}`).set(notif));
        if (u.telegramChatId && !chatIds.has(u.telegramChatId)) {
          chatIds.add(u.telegramChatId);
          writes.push(sendTelegram(u.telegramChatId, text));
        }
      }
      const mark = { reminderSentFor: c.nextDue };
      if (isOverdue) mark.overdueNudgedAt = now;
      writes.push(db.ref(`maintenanceContracts/${id}`).update(mark));
      await Promise.all(writes);
      sent++;
      console.log(`Reminder sent: ${c.customer} due ${c.nextDue} (${days}d) → ${admins.length} admin(s), ${chatIds.size} Telegram`);
    }
    console.log(`Maintenance check done — ${sent} reminder(s) sent`);
  }
);
