// Script to run all bank syncs
// Useful for running bank syncs on a daily/weekly schedule
const {
  closeBudget,
  openBudget,
  stampAccountLastUpdated,
  setSyncStatusPrefix,
} = require('./utils');
const api = require('@actual-app/api');

const FAIL_STATUSES = new Set([
  'failed',
  'reauth-required',
  'rate-limit-exceeded',
  'timed-out',
]);

(async () => {
  await openBudget();
  console.log("syncing banks...");

  try {
    await api.runBankSync();
    console.log("Bank sync completed successfully");
  } catch (err) {
    console.error(`Bank sync completed with errors: ${err.message}`);
    process.exitCode = 1;
  }

  // Per-account: stamp notes + flip ✓/Ｘ from Actual's last_sync / bank_sync_status.
  const cutoff = Date.now() - 10 * 60 * 1000;
  const result = await api.runQuery(
    api.q('accounts')
      .filter({ closed: false })
      .select(['id', 'name', 'last_sync', 'account_sync_source', 'bank_sync_status'])
  );
  for (const account of result.data) {
    if (!account.account_sync_source) continue;

    const lastSync = account.last_sync ? parseInt(account.last_sync, 10) : NaN;
    const syncedThisRun = !Number.isNaN(lastSync) && lastSync >= cutoff;

    if (syncedThisRun) {
      await stampAccountLastUpdated(account);
      await setSyncStatusPrefix(account, true);
      console.log(`OK ${account.name}`);
    } else if (FAIL_STATUSES.has(account.bank_sync_status)) {
      await setSyncStatusPrefix(account, false);
      console.log(`FAIL ${account.name} (${account.bank_sync_status})`);
    }
  }

  await closeBudget();
})();
