// Script to run all bank syncs
// Useful for running bank syncs on a daily/weekly schedule
const { closeBudget, openBudget } = require('./utils');
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

  await closeBudget();
})();