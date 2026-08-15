// Script to run all bank syncs
// Useful for running bank syncs on a daily/weekly schedule
const {
  closeBudget,
  openBudget,
  stampAccountLastUpdated,
  setSyncStatusPrefix,
} = require('../lib/actual');
const api = require('@actual-app/api');

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

  // Per-account: stamp notes + flip ✓/Ｘ from whether last_sync updated this run.
  // Any linked account that did not sync gets Ｘ (status is logged for diagnosis).
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
    } else {
      await setSyncStatusPrefix(account, false);
      console.log(`FAIL ${account.name} (${account.bank_sync_status || 'no-sync'})`);
    }
  }

  await closeBudget();
})();
