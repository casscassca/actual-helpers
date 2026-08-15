// Guideline 401k balance via password + TOTP, then GraphQL CurrentBalanceSummary.
const api = require('@actual-app/api');
const path = require('path');
const OTPAuth = require('otpauth');
const {
  closeBudget,
  getAccountNote,
  openBudget,
  setSyncStatusPrefix,
  stampAccountLastUpdated,
  stripSyncPrefix,
} = require('../lib/actual');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ORIGIN = 'https://my.guideline.com';
const GRAPHQL = `${ORIGIN}/api/graphql?n=CurrentBalanceSummary`;
const SESSIONS = `${ORIGIN}/api/v1/sessions.json`;
const VERIFY_OTP = `${ORIGIN}/api/v1/sessions/verify_otp.json`;
const DEFAULT_ACCOUNT = '24E08123-7FT8R';

const BALANCE_QUERY = `
query CurrentBalanceSummary($accountNumber: String!) {
  savers {
    account(accountNumber: $accountNumber) {
      balanceSummary {
        currentBalance {
          value {
            cents
            display {
              cents
            }
          }
        }
      }
    }
  }
}
`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function totpFromEnv() {
  const secret = requireEnv('GUIDELINE_TOTP_SECRET').trim();
  if (secret.startsWith('op://')) {
    throw new Error('GUIDELINE_TOTP_SECRET is a 1Password reference (op://), not the TOTP seed');
  }
  const totp = secret.startsWith('otpauth://')
    ? OTPAuth.URI.parse(secret)
    : new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret.replace(/\s+/g, '')) });
  return totp;
}

function totpCodes(totp) {
  const period = totp.period || 30;
  const now = Date.now();
  return [-1, 0, 1].map((w) => totp.generate({ timestamp: now + w * period * 1000 }));
}

function headerGet(headers, name) {
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] || headers[name.toLowerCase()];
}

class GuidelineClient {
  constructor() {
    this.cookies = new Map();
    this.jwtAuth = '';
    this.mfaToken = '';
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    for (const line of raw) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const jwt = headerGet(res.headers, 'x-jwt') || headerGet(res.headers, 'x-jwt-auth');
    if (jwt) {
      this.jwtAuth = /^Bearer/i.test(jwt) ? jwt : `Bearer: ${jwt}`;
    }
    const mfa = headerGet(res.headers, 'x-mfa-token');
    if (mfa) this.mfaToken = mfa;
  }

  headers(extra = {}) {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: ORIGIN,
      referer: `${ORIGIN}/login`,
      'x-gl-client': 'web',
      'x-gl-tenant-id': 'gdl',
      'x-js-utc-offset': String(-new Date().getTimezoneOffset()),
      ...extra,
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (this.jwtAuth) headers['x-jwt-auth'] = this.jwtAuth;
    if (this.mfaToken) headers['x-mfa-token'] = this.mfaToken;
    return headers;
  }

  async request(url, { method = 'POST', body, accept } = {}) {
    const res = await fetch(url, {
      method,
      headers: this.headers(accept ? { accept } : {}),
      body: body == null ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Guideline ${url} returned non-JSON (${res.status})`);
    }
    if (!res.ok) {
      const msg = data.errors?.[0]?.full_message
        || data.errors?.[0]?.message
        || data.message
        || res.statusText;
      throw new Error(`Guideline ${res.status}: ${msg}`);
    }
    return data;
  }
}

function pickAuthenticator(otp) {
  const methods = otp?.mfa_methods || [];
  const auth = methods.find((m) => m.type === 'Authenticator') || methods[0];
  if (!auth?.id || !otp?.jwts) {
    throw new Error('Guideline login did not return authenticator MFA challenge');
  }
  return auth;
}

async function login(client) {
  const data = await client.request(SESSIONS, {
    body: {
      email: requireEnv('GUIDELINE_EMAIL'),
      password: requireEnv('GUIDELINE_PASSWORD'),
    },
  });
  if (!data.otp) return data;

  const method = pickAuthenticator(data.otp);
  const totp = totpFromEnv();
  let verified;
  let lastErr;
  for (const code of totpCodes(totp)) {
    try {
      verified = await client.request(VERIFY_OTP, {
        body: {
          jwts: data.otp.jwts,
          code,
          auth_method_id: method.id,
          remember: true,
        },
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!verified) throw lastErr;
  if (!client.jwtAuth) {
    throw new Error('Guideline MFA succeeded but no session JWT was returned');
  }
  return verified;
}

async function currentBalanceCents(client) {
  const accountNumber = process.env.GUIDELINE_ACCOUNT_NUMBER || DEFAULT_ACCOUNT;
  const data = await client.request(GRAPHQL, {
    accept: 'application/graphql-response+json, application/json',
    body: {
      operationName: 'CurrentBalanceSummary',
      query: BALANCE_QUERY,
      variables: { accountNumber },
    },
  });
  if (data.errors?.length) {
    throw new Error(`Guideline GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const cents = data.data?.savers?.account?.balanceSummary?.currentBalance?.value?.cents;
  if (!Number.isFinite(cents)) {
    throw new Error('Guideline GraphQL returned no currentBalance.cents');
  }
  return cents;
}

async function findGuidelineAccount(accounts) {
  let byName = null;
  for (const account of accounts) {
    if (account.closed) continue;
    const note = (await getAccountNote(account)) || '';
    if (note.includes('guideline:')) return account;
    if (/^guideline$/i.test(stripSyncPrefix(account.name).trim())) byName = account;
  }
  return byName;
}

(async () => {
  const client = new GuidelineClient();
  await login(client);
  const cents = await currentBalanceCents(client);
  console.log('Guideline balance (cents):', cents);

  await openBudget();
  try {
    const account = await findGuidelineAccount(await api.getAccounts());
    if (!account) {
      throw new Error('No open Guideline account (add guideline: to the account note)');
    }
    await api.updateAccount(account.id, { balance_current: cents });
    await stampAccountLastUpdated(account);
    await setSyncStatusPrefix(account, true);
    console.log('Updated', account.name);
  } finally {
    await closeBudget();
  }
})().catch(async (err) => {
  console.error(err.message || err);
  try {
    await openBudget();
    const account = await findGuidelineAccount(await api.getAccounts());
    if (account) await setSyncStatusPrefix(account, false);
    await closeBudget();
  } catch {
    // keep the original error
  }
  process.exit(1);
});
