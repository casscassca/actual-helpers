const api = require('@actual-app/api');
const {
  closeBudget,
  ensurePayee,
  getAccountBalance,
  getAccountNote,
  getLastTransactionDate,
  getTagValue,
  openBudget,
  showPercent,
  stampAccountLastUpdated,
  stripSyncPrefix,
} = require('../lib/actual');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

function daysInYear(year) {
  return ((year % 4 === 0 && year % 100 > 0) || year % 400 == 0) ? 366 : 365;
}

function wantsBalanceUpdate(note) {
  return /(?:^|\s)balance_update:true\b/i.test(note || '');
}

async function mark(account, ok) {
  const newName = `${ok ? '✓' : 'Ｘ'} ${stripSyncPrefix(account.name).trim()}`;
  if (newName === account.name) return;
  await api.updateAccount(account.id, { name: newName });
  account.name = newName;
}

(async () => {
  await openBudget();
  let hadErrors = false;

  const payeeId = await ensurePayee(process.env.INTEREST_PAYEE_NAME || 'Loan Interest');

  const accounts = await api.getAccounts();
  for (const account of accounts) {
    if (account.closed) continue;

    const note = await getAccountNote(account);
    if (!note) continue;

    let interestRate = parseFloat(getTagValue(note, 'interestRate', 0.0));
    const interestDay = parseInt(getTagValue(note, 'interestDay', 0));
    if (!interestRate || !interestDay) continue;

    try {
      const kind = getTagValue(note, 'interest', 'monthly');

      const interestTransactionDate = new Date();
      if (interestTransactionDate.getDate() < interestDay) {
        interestTransactionDate.setMonth(interestTransactionDate.getMonth() - 1);
      }
      interestTransactionDate.setDate(interestDay);
      interestTransactionDate.setHours(5, 0, 0, 0);

      const cutoff = new Date(interestTransactionDate);
      cutoff.setMonth(cutoff.getMonth() - 1);
      cutoff.setDate(cutoff.getDate() + 1);

      // Include outflows (loan starting balance is usually negative).
      const lastDate = await getLastTransactionDate(account, cutoff, true);
      if (!lastDate) {
        throw new Error('no transactions before cutoff');
      }
      const daysPassed = Math.round(
        (interestTransactionDate.setHours(0, 0, 0, 0) - new Date(lastDate).setHours(0, 0, 0, 0)) / 86400000
      );

      let period = 12;
      let numPeriods = 1;
      switch (kind) {
        case 'daily':
        case 'daily-simple':
          period = daysInYear(interestTransactionDate.getFullYear());
          numPeriods = daysPassed;
          break;
        case 'actual':
          period = daysInYear(interestTransactionDate.getFullYear()) / daysPassed;
          break;
        default:
          break;
      }

      const balance = await getAccountBalance(account, interestTransactionDate);

      let compoundedInterest;
      if (kind == 'daily-simple')
        compoundedInterest = Math.round(balance * (interestRate / 365) * numPeriods);
      else
        compoundedInterest = Math.round(balance * (Math.pow(1 + interestRate / period, numPeriods) - 1));

      const rateLabel = showPercent(interestRate);

      console.log(`== ${account.name} ==`);
      console.log(` -> Balance:  ${balance}`);
      console.log(`      as of ${lastDate}`);
      console.log(` -> # days:   ${daysPassed}`);
      console.log(` -> Interest: ${compoundedInterest} (${rateLabel})`);

      if (compoundedInterest) {
        await api.importTransactions(account.id, [{
          date: interestTransactionDate,
          payee: payeeId,
          amount: compoundedInterest,
          cleared: true,
        }]);
      }

      if (wantsBalanceUpdate(note)) {
        await api.updateAccount(account.id, {
          balance_current: balance + (compoundedInterest || 0),
        });
        await stampAccountLastUpdated(account);
        await mark(account, true);
      }
    } catch (err) {
      hadErrors = true;
      console.error(`== ${account.name} == FAILED: ${err.message || err}`);
      if (wantsBalanceUpdate(note)) {
        await mark(account, false);
      }
    }
  }

  await closeBudget();
  if (hadErrors) process.exit(1);
})();
