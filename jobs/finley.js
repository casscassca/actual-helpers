// Finley: HA Tesla odometer + KBB value → Actual balance_current (5th and 20th).
//
// www.kbb.com answers non-browser fetches with an Akamai 403, so the old
// embedded "tradein" blob is gone. The Price Advisor trade-in endpoint on
// upa.syndication.kbb.com still returns the condition value. Its key is the
// public widget key KBB embeds in its own pages, not a user credential.
const path = require('path');

const KBB_WIDGET_KEY = '76a9532b-fa54-4d02-8e6a-91c3fb85376c';
const KBB_TRADEIN_URL = 'https://upa.syndication.kbb.com/priceadvisorusedcar/';

// Capitals, used only when FINLEY_KBB_URL has statecode and no zipcode.
// The trade-in API will not price a state without a ZIP.
const STATE_ZIPS = {
  al: '36104', ak: '99801', az: '85003', ar: '72201', ca: '95814', co: '80203',
  ct: '06103', de: '19901', dc: '20001', fl: '32301', ga: '30303', hi: '96813',
  id: '83702', il: '62701', in: '46204', ia: '50309', ks: '66603', ky: '40601',
  la: '70801', me: '04330', md: '21401', ma: '02108', mi: '48933', mn: '55102',
  ms: '39201', mo: '65101', mt: '59601', ne: '68508', nv: '89701', nh: '03301',
  nj: '08608', nm: '87501', ny: '12207', nc: '27601', nd: '58501', oh: '43215',
  ok: '73102', or: '97301', pa: '17101', ri: '02903', sc: '29201', sd: '57501',
  tn: '37219', tx: '78701', ut: '84111', vt: '05602', va: '23219', wa: '98501',
  wv: '25301', wi: '53703', wy: '82001',
};

let api;
let budget;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function responseSnippet(body) {
  const text = String(body)
    .replace(/apikey=[^&\s"']+/gi, 'apikey=REDACTED')
    .replace(/\s+/g, ' ')
    .trim();
  const at = text.search(/"values"|Access Denied|"error"/i);
  const slice = at > 40 ? text.slice(Math.max(0, at - 40), at + 200) : text;
  return slice.slice(0, 240);
}

function kbbHttpError(status, body, detail) {
  return new Error(`KBB ${detail} (HTTP ${status}): ${responseSnippet(body)}`);
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

function conditionKey(condition) {
  const key = String(condition || 'excellent').toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return 'excellent';
  return key;
}

function pricePath(priceType) {
  return /private/.test(String(priceType || '')) ? 'privateparty' : 'tradein';
}

function resolveZip(url) {
  const explicit = url.searchParams.get('zipcode') || url.searchParams.get('zip');
  if (explicit) return { zip: explicit, source: 'zipcode' };
  const state = (url.searchParams.get('statecode') || url.searchParams.get('state') || '').toLowerCase();
  if (state && STATE_ZIPS[state]) {
    return { zip: STATE_ZIPS[state], source: `statecode=${state}` };
  }
  throw new Error(
    'KBB trade-in API needs a ZIP. Add zipcode= to FINLEY_KBB_URL (statecode alone is not a pricing region).',
  );
}

function parseKbbTradeIn(payload, priceType) {
  const values = payload?.Data?.APIData?.vehicle?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('price JSON not found');
  }
  const want = pricePath(priceType);
  const band = values.find((v) => String(v.type || '').toLowerCase() === want);
  const value = Number(band && band.value);
  if (!band || !Number.isFinite(value)) {
    throw new Error(`has no ${want} value`);
  }
  if (value < 500 || value > 500000) {
    throw new Error(`${want} value ${value} is not a plausible dollar amount`);
  }
  return value;
}

async function fetchKbbDollars(kbbUrl, miles) {
  const page = new URL(kbbUrlWithMileage(kbbUrl, miles));
  console.log('KBB URL (mileage updated):', page.toString());
  const priceType = process.env.FINLEY_PRICE_TYPE || page.searchParams.get('pricetype') || 'trade-in';
  const condition = conditionKey(process.env.FINLEY_CONDITION || page.searchParams.get('condition') || 'excellent');
  const vehicleId = page.searchParams.get('vehicleid') || page.searchParams.get('vehicleId');
  if (!vehicleId) throw new Error('FINLEY_KBB_URL is missing vehicleid');
  const { zip, source } = resolveZip(page);

  const apiUrl = new URL(pricePath(priceType), KBB_TRADEIN_URL);
  apiUrl.searchParams.set('apikey', KBB_WIDGET_KEY);
  apiUrl.searchParams.set('vehicleid', vehicleId);
  apiUrl.searchParams.set('mileage', String(miles));
  apiUrl.searchParams.set('condition', condition);
  apiUrl.searchParams.set('zipcode', zip);
  apiUrl.searchParams.set('format', 'json');
  console.log(`KBB pricing: ${pricePath(priceType)} vehicle ${vehicleId} ${condition} zip ${zip} (${source})`);

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: { Accept: 'application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timed out' : (err.message || err);
    throw new Error(`KBB trade-in lookup failed (${reason})`);
  }
  const body = await res.text();
  if (!res.ok) throw kbbHttpError(res.status, body, 'trade-in lookup failed');

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw kbbHttpError(res.status, body, 'trade-in lookup was not JSON');
  }
  try {
    return parseKbbTradeIn(payload, priceType);
  } catch (err) {
    throw kbbHttpError(res.status, body, err.message);
  }
}

async function stampMileage(account, miles) {
  let note = (await budget.getAccountNote(account)) || '';
  const mileage = `mileage:${miles}`;
  if (/\bmileage:\S+/.test(note)) {
    note = note.replace(/\bmileage:\S+/, mileage);
  } else {
    note = note ? `${mileage}\n${note}` : mileage;
  }
  await budget.setAccountNote(account, budget.replaceLastUpdatedStamp(note));
}

function findFinley(accounts) {
  return accounts.find((a) => !a.closed && /^finley$/i.test(budget.stripSyncPrefix(a.name).trim()));
}

async function markFinley(account, ok) {
  const newName = `${ok ? '✓' : 'Ｘ'} ${budget.stripSyncPrefix(account.name).trim()}`;
  if (newName === account.name) return;
  await api.updateAccount(account.id, { name: newName });
  account.name = newName;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  api = require('@actual-app/api');
  budget = require('../lib/actual');

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

  await budget.openBudget();
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
    await budget.closeBudget();
  }
}

module.exports = {
  fetchKbbDollars,
  parseKbbTradeIn,
  kbbUrlWithMileage,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
