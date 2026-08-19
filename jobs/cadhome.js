// CAD Home Value: apply bot-written note tags (1st/15th) on the 5th and 20th.
const api = require('@actual-app/api');
const path = require('path');
const {
  closeBudget,
  getAccountNote,
  openBudget,
  stampAccountLastUpdated,
  stripSyncPrefix,
} = require('../lib/actual');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ACCOUNT_NAME = /^cad home value$/i;

function tagLine(note, tag) {
  const match = (note || '').match(new RegExp(`(?:^|\\n)\\s*${tag}:([^\\n]*)`, 'i'));
  return match ? match[1].trim() : undefined;
}

function parseStamp(raw) {
  if (!raw) return NaN;
  return Date.parse(raw);
}

function findCadHome(accounts) {
  return accounts.find((a) => !a.closed && ACCOUNT_NAME.test(stripSyncPrefix(a.name).trim()));
}

async function mark(account, ok) {
  const newName = `${ok ? '✓' : 'Ｘ'} ${stripSyncPrefix(account.name).trim()}`;
  if (newName === account.name) return;
  await api.updateAccount(account.id, { name: newName });
  account.name = newName;
}

(async () => {
  await openBudget();
  try {
    const account = findCadHome(await api.getAccounts());
    if (!account) throw new Error('No open account named "CAD Home Value"');

    const note = (await getAccountNote(account)) || '';
    const fetchedRaw = tagLine(note, 'last_fetched');
    const updatedRaw = tagLine(note, 'last_updated');
    const fetchedAt = parseStamp(fetchedRaw);
    const updatedAt = parseStamp(updatedRaw);
    const value = parseInt(tagLine(note, 'value'), 10);

    if (!fetchedRaw || Number.isNaN(fetchedAt)) {
      throw new Error('CAD Home Value note is missing a parseable last_fetched:');
    }
    if (!Number.isFinite(value)) {
      throw new Error('CAD Home Value note is missing a numeric value:');
    }
    if (!Number.isNaN(updatedAt) && fetchedAt <= updatedAt) {
      throw new Error(
        `CAD Home Value last_fetched (${fetchedRaw}) is not newer than last_updated (${updatedRaw})`,
      );
    }

    const cents = Math.round(value * 100);
    console.log('CAD Home Value last_fetched:', fetchedRaw);
    console.log('CAD Home Value value:', value);
    await api.updateAccount(account.id, { balance_current: cents });
    await stampAccountLastUpdated(account);
    await mark(account, true);
    console.log('Updated', account.name, 'to', cents, 'cents');
  } catch (err) {
    try {
      const account = findCadHome(await api.getAccounts());
      if (account) await mark(account, false);
    } catch {
      // keep the original error
    }
    throw err;
  } finally {
    await closeBudget();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
