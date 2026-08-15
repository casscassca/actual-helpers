// Finley: HA Tesla odometer + KBB value → Actual balance_current (5th and 20th).
const api = require('@actual-app/api');
const path = require('path');
const {
  closeBudget,
  getAccountNote,
  openBudget,
  replaceLastUpdatedStamp,
  setAccountNote,
  stripSyncPrefix,
} = require('../lib/actual');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function haOdometer() {
  const haUrl = (process.env.HA_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
  const entity = process.env.FINLEY_ODOMETER_ENTITY || 'sensor.finley_odometer';
  const res = await fetch(`${haUrl}/api/states/${entity}`, {
    headers: { Authorization: `Bearer ${requireEnv('HA_TOKEN')}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HA ${entity}: ${res.status} ${data.message || ''}`);
  }
  const miles = parseFloat(data.state);
  if (!Number.isFinite(miles)) {
    throw new Error(`HA ${entity} is ${data.state}`);
  }
  return Math.round(miles);
}

function kbbUrlWithMileage(rawUrl, miles) {
  const url = new URL(rawUrl);
  url.searchParams.set('mileage', String(miles));
  return url.toString();
}

function parseKbbValue(html, priceType, condition) {
  const key = /private/.test(priceType) ? 'privateparty' : 'tradein';
  const match = html.match(new RegExp(`"${key}":(\\{[^}]+\\})`, 'i'));
  if (!match) throw new Error('KBB price JSON not found (page layout may have changed)');
  const band = JSON.parse(match[1]);
  const value = band[condition];
  if (!Number.isFinite(value)) {
    throw new Error(`KBB has no ${condition} ${key} value: ${match[1]}`);
  }
  return value;
}

async function fetchKbbDollars(kbbUrl, miles) {
  const url = kbbUrlWithMileage(kbbUrl, miles);
  console.log('KBB URL (mileage updated):', url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.kbb.com/',
    },
  });
  const html = await res.text();
  const parsed = new URL(kbbUrl);
  const priceType = process.env.FINLEY_PRICE_TYPE || parsed.searchParams.get('pricetype') || 'trade-in';
  const condition = process.env.FINLEY_CONDITION || parsed.searchParams.get('condition') || 'excellent';
  return parseKbbValue(html, priceType, condition);
}

async function stampMileage(account, miles) {
  let note = (await getAccountNote(account)) || '';
  const mileage = `mileage:${miles}`;
  if (/\bmileage:\S+/.test(note)) {
    note = note.replace(/\bmileage:\S+/, mileage);
  } else {
    note = note ? `${mileage}\n${note}` : mileage;
  }
  await setAccountNote(account, replaceLastUpdatedStamp(note));
}

function findFinley(accounts) {
  return accounts.find((a) => !a.closed && /^finley$/i.test(stripSyncPrefix(a.name).trim()));
}

async function markFinley(account, ok) {
  const newName = `${ok ? '✓' : 'Ｘ'} ${stripSyncPrefix(account.name).trim()}`;
  if (newName === account.name) return;
  await api.updateAccount(account.id, { name: newName });
  account.name = newName;
}

(async () => {
  const kbbUrl = requireEnv('FINLEY_KBB_URL');

  let miles;
  let dollars;
  let fetchErr;
  try {
    miles = await haOdometer();
    console.log('HA odometer:', miles, 'mi');
    dollars = await fetchKbbDollars(kbbUrl, miles);
    console.log('KBB value:', dollars);
  } catch (err) {
    fetchErr = err;
  }

  await openBudget();
  try {
    const account = findFinley(await api.getAccounts());
    if (!account) throw new Error('No open account named "Finley"');

    if (fetchErr) {
      await markFinley(account, false);
      throw fetchErr;
    }

    await api.updateAccount(account.id, { balance_current: Math.round(dollars * 100) });
    await stampMileage(account, miles);
    await markFinley(account, true);
    console.log('Updated', account.name, 'to', dollars, 'at', miles, 'mi');
  } finally {
    await closeBudget();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
