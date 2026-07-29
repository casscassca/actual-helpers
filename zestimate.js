const api = require('@actual-app/api');
const { closeBudget, ensurePayee, getAccountBalance, getAccountNote, getTagValue, openBudget } = require('./utils');
require("dotenv").config();

async function getZestimate(zillowUrl) {
    const response = await fetch(`https://api.hasdata.com/scrape/zillow/property?url=${encodeURIComponent(zillowUrl)}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.HASDATA_API_KEY || '',
        }
    });

    const data = await response.json();

    if (!data.property?.zestimate?.zestimate) {
        console.log('No zestimate in response:', JSON.stringify(data, null, 2));
        return undefined;
    }

    return data.property.zestimate.zestimate;
}

(async function() {
    await openBudget();

    const payeeId = await ensurePayee(process.env.HASDATA_PAYEE_NAME || 'Zestimate');

    const accounts = await api.getAccounts();
    for (const account of accounts) {
        if (account.closed) continue;

        const note = await getAccountNote(account);
        if (!note || !note.includes('zestimate:')) continue;

        const zillowUrl = getTagValue(note, 'zestimate');
        console.log('Fetching Zestimate for account:', account.name);

        const zestimate = await getZestimate(zillowUrl);
        if (!zestimate) {
            console.log('Unable to get Zestimate, skipping');
            continue;
        }

        const value = zestimate * 100;
        const balance = await getAccountBalance(account);
        const diff = value - balance;

        console.log('Zestimate:', zestimate);
        console.log('Balance:', balance / 100);
        console.log('Difference:', diff / 100);

        if (diff !== 0) {
            await api.importTransactions(account.id, [{
                date: new Date(),
                payee: payeeId,
                amount: diff,
                cleared: true,
                reconciled: true,
                notes: `Update Zestimate to ${zestimate}`,
            }]);
        }
    }
    await closeBudget();
})();