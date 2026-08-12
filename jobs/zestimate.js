const api = require('@actual-app/api');
const { closeBudget, getAccountNote, getTagValue, openBudget, stampAccountLastUpdated } = require('../lib/actual');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

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

        let sellingCostAdjustment = 0;
        if (note.includes('sellingCostAdjustment:')) {
            sellingCostAdjustment = parseFloat(getTagValue(note, 'sellingCostAdjustment'));
        }

        const adjustedValue = zestimate * (1 - sellingCostAdjustment);

        console.log('Zestimate:', zestimate);
        console.log('Selling cost adjustment:', sellingCostAdjustment);
        console.log('Adjusted value:', adjustedValue);

        await api.updateAccount(account.id, { balance_current: Math.round(adjustedValue * 100) });
        await stampAccountLastUpdated(account);
        console.log('Updated balance_current to', adjustedValue);
    }
    await closeBudget();
})();