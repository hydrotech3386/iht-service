const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');
const { promisify } = require('util');
const zlib = require('zlib');

const gzip = promisify(zlib.gzip);

initializeApp({
  databaseURL: 'https://service-schedule-2c481-default-rtdb.firebaseio.com',
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
