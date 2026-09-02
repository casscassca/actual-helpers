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

  const listed = await api.runQuery(
    api.q('accounts')
      .filter({ closed: false })
      .select(['id', 'name', 'account_sync_source'])
  );
  const linked = listed.data.filter((account) => account.account_sync_source === 'simpleFin');

  let hadError = false;
  for (const account of linked) {
    try {
      await api.runBankSync({ accountId: account.id });
      console.log(`synced ${account.name}`);
    } catch (err) {
      hadError = true;
      console.error(`Bank sync failed for ${account.name}: ${err.message}`);
    }
  }

  if (!hadError) {
    console.log("Bank sync completed successfully");
  } else {
    process.exitCode = 1;
  }

  const cutoff = Date.now() - 10 * 60 * 1000;
  const result = await api.runQuery(
    api.q('accounts')
      .filter({ closed: false })
      .select(['id', 'name', 'last_sync', 'account_sync_source', 'bank_sync_status'])
  );
  for (const account of result.data) {
    if (account.account_sync_source !== 'simpleFin') continue;

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
