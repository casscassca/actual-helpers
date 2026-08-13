// Pull unpaid principal from Valon/ServiceMac GraphQL (Firebase password login).
const api = require('@actual-app/api');
const path = require('path');
const { closeBudget, getAccountNote, openBudget, stampAccountLastUpdated } = require('../lib/actual');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const GRAPHQL = 'https://api.valon.com/v1/graphql';
const LOAN_QUERY = `
query GetBorrowerDashboardLoanInfo($sid: ID!) {
  loan(sid: $sid) {
    sid
    annualInterestRatePercent
    accountingStateSummary {
      unpaidPrincipalBalance
      interestBearingUnpaidPrincipalBalance
    }
  }
}
`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

async function firebaseIdToken() {
  const key = requireEnv('SERVICEMAC_FIREBASE_API_KEY');
  const tenantId = process.env.SERVICEMAC_FIREBASE_TENANT_ID || 'servicemac-borrowers-u0cbn';
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: requireEnv('SERVICEMAC_EMAIL'),
        password: requireEnv('SERVICEMAC_PASSWORD'),
        returnSecureToken: true,
        tenantId,
      }),
    },
  );
  const data = await res.json();
  if (!data.idToken) {
    throw new Error(`Firebase login failed: ${data.error?.message || res.status}`);
  }
  return data.idToken;
}

async function unpaidPrincipal(idToken) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      accept: '*/*',
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
      origin: 'https://lakeview.servicemacusa.com',
      referer: 'https://lakeview.servicemacusa.com/',
      'x-client-source': 'web',
      'x-tenant-sid': requireEnv('SERVICEMAC_TENANT_SID'),
    },
    body: JSON.stringify({
      operationName: 'GetBorrowerDashboardLoanInfo',
      variables: {
        sid: requireEnv('SERVICEMAC_LOAN_SID'),
      },
      query: LOAN_QUERY,
    }),
  });
  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`Valon GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
  }
  const summary = data.data?.loan?.accountingStateSummary;
  const raw = summary?.unpaidPrincipalBalance ?? summary?.interestBearingUnpaidPrincipalBalance;
  const dollars = parseFloat(raw);
  if (!Number.isFinite(dollars)) {
    throw new Error(`No unpaid principal in response: ${JSON.stringify(data)}`);
  }
  return dollars;
}

(async () => {
  const dollars = await unpaidPrincipal(await firebaseIdToken());
  const cents = -Math.round(dollars * 100);
  console.log('ServiceMac unpaid principal:', dollars);

  await openBudget();
  try {
    const accounts = await api.getAccounts();
    let found = false;
    for (const account of accounts) {
      if (account.closed) continue;
      const note = await getAccountNote(account);
      if (!note || !note.includes('servicemac:')) continue;
      found = true;
      console.log('Updating', account.name);
      await api.updateAccount(account.id, { balance_current: cents });
      await stampAccountLastUpdated(account);
    }
    if (!found) {
      throw new Error('No account note contains servicemac:');
    }
  } finally {
    await closeBudget();
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
