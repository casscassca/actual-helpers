// Daily Actual backup: export zip via the API, rclone copy to Google Drive.
// Same idea as https://github.com/rodriguestiago0/actualbudget-backup, without a second container.
const api = require('@actual-app/api');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeBudget, openBudget } = require('../lib/actual');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const remoteName = process.env.RCLONE_REMOTE || 'gdrive';
const remoteDir = (process.env.RCLONE_REMOTE_DIR || 'backups/actual').replace(/\/+$/, '');
const keepDays = parseInt(process.env.BACKUP_KEEP_DAYS || '30', 10);
const dest = `${remoteName}:${remoteDir}`;

function stampToday() {
  return new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })
    .replace(/-/g, '');
}

function rclone(args) {
  execFileSync('rclone', args, { stdio: 'inherit' });
}

(async () => {
  const syncId = process.env.ACTUAL_SYNC_ID || process.env.ACTUAL_BUDGET_ID;
  if (!syncId) {
    console.error('ACTUAL_SYNC_ID is required');
    process.exit(1);
  }

  const zipName = `backup.${syncId}.${stampToday()}.zip`;
  const zipPath = path.join(os.tmpdir(), zipName);

  await openBudget();
  try {
    console.log('exporting budget');
    const bytes = await api.exportBudget();
    fs.writeFileSync(zipPath, Buffer.from(bytes));
    console.log(`wrote ${zipPath} (${bytes.length} bytes)`);
  } finally {
    await closeBudget();
  }

  try {
    console.log(`uploading to ${dest}/${zipName}`);
    rclone(['copy', zipPath, dest]);

    if (keepDays > 0) {
      console.log(`pruning backups older than ${keepDays} days`);
      const listing = execFileSync('rclone', ['lsf', dest, '--min-age', `${keepDays}d`], {
        encoding: 'utf8',
      });
      for (const file of listing.split('\n').map((s) => s.trim()).filter(Boolean)) {
        console.log(`deleting ${file}`);
        rclone(['delete', `${dest}/${file}`]);
      }
    }
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  console.log('backup complete');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
