// Script to run all bank syncs
// Useful for running bank syncs on a daily/weekly schedule
const { closeBudget, openBudget, stampAccountLastUpdated } = require('./utils');
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

  // Stamp notes for accounts Actual itself marked as synced this run.
  // last_sync is set per-account on success, so this covers partial failures.
  const cutoff = Date.now() - 10 * 60 * 1000;
  const result = await api.runQuery(
    api.q('accounts')
      .filter({ closed: false })
      .select(['id', 'name', 'last_sync', 'account_sync_source'])
  );
  for (const account of result.data) {
    if (!account.account_sync_source || !account.last_sync) continue;
    const lastSync = parseInt(account.last_sync, 10);
    if (Number.isNaN(lastSync) || lastSync < cutoff) continue;
    await stampAccountLastUpdated(account);
    console.log(`Stamped last_updated on ${account.name}`);
  }

  await closeBudget();
})();
