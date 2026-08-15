const { getAppConfigFromEnv } = require("./config");
const actual = require("@actual-app/api");
const fs = require("fs");
const inquirer = require("inquirer");
let { q, runQuery } = require('@actual-app/api');


const appConfig = getAppConfigFromEnv();

/**
 * 
 * @returns {Promise<typeof actual>}
 */
async function initialize(config) {
    try {
        const tmp_dir = `./temp_data_actual/${config.get("user")}`
        fs.mkdirSync(tmp_dir, { recursive: true });
        await actual.init({
            serverURL: appConfig.ACTUAL_SERVER_URL,
            password: appConfig.ACTUAL_SERVER_PASSWORD,
            dataDir: tmp_dir
        });

        let id = config.get("budget_id")
        if (!id) {
            id = (await inquirer.prompt({
                name: "budget_id",
                message: `This is your (${config.get('user')}) first time using this user, what is your budget sync Id? (Can be found in advanced settings on Actual as the 'Sync Id')`,
            })).budget_id
            config.set("budget_id", id)
        }

        if (appConfig.ACTUAL_SERVER_ENCRYPTION_PASSWORD) {
            await actual.downloadBudget(id, { password: appConfig.ACTUAL_SERVER_ENCRYPTION_PASSWORD });
        }
        else {
            await actual.downloadBudget(id);
        }
    } catch (e) {
        throw new Error(`Actual Budget Error: ${e.message}`);
    }

    return actual;
}

/**
 * 
 * @param {typeof actual} actualInstance 
 */
function listAccounts(actualInstance) {
    return actualInstance.getAccounts();
}

/**
 * Only works for the past month
 * @param {typeof actual} actualInstance 
 * @param {*} accountId 
 */
async function getLastTransactionDate(actualInstance, accountId) {
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    const transactions = await actualInstance.getTransactions(accountId, monthAgo, new Date());

    if (transactions.length === 0) {
        return new Date(0);
    }

    // Transactions of the day are already imported, so start from the next day.
    const last = new Date(transactions[0].date);
    last.setDate(last.getDate() + 1);

    return last;
}

const ABN_AMRO_TRANSACTION_MAPPER = (accountId) => (transaction) => {
    const description = transaction.name
    let notes = description;
    let payee = description;

    if (description.includes("TRTP")) {
        let splitted = description.split("/");
        if (splitted[2].includes("iDEAL") || splitted[2].includes("SEPA OVERBOEKING")) {
            payee = splitted[8].trim();
            notes = splitted[10].trim();
        } else if (splitted[2].includes("SEPA Incasso")) {
            payee = splitted[6].trim();
            notes = splitted[10].trim();
        }
    } else if (description.includes("SEPA iDEAL")) {
        let splitted = description.split("Naam:");
        payee = splitted[1].split("Omschrijving:")[0].trim();
        notes = splitted[1].split("Omschrijving:")[1].split("Kenmerk:")[0].trim();
    } else if (description.includes("BEA")) {
        let splitted = description.split(",");
        let info = splitted[1].replace(" Apple Pay", "").replace("Betaalpas", "").replace("PAS544", "").trim();
        payee = info;
    } else if (description.includes("SEPA Incasso")) {
        let splitted = description.split("Naam:");
        if (splitted[1].includes("Machtiging:")) {
            payee = splitted[1].split("Machtiging:")[0].trim();
        } else {
            payee = splitted[1].split("Omschrijving:")[0].trim();
        }
        notes = splitted[1].split("Omschrijving:")[1].split("IBAN:")[0].trim();
    } else if (description.includes("SEPA Overboeking")) {
        let splitted = description.split("Naam:");
        if (splitted.length > 1) {
            if (splitted[1].includes("Omschrijving:")) {
                payee = splitted[1].split("Omschrijving:")[0].trim();
                if (splitted[1].includes("Kenmerk:")) {
                    notes = splitted[1].split("Omschrijving:")[1].split("Kenmerk:")[0].trim();
                } else {
                    notes = splitted[1].split("Omschrijving:")[1].trim();
                }
            } else {
                payee = splitted[1].trim();
                notes = "";
            }
        } else {
            payee = splitted[0];
            notes = "";
        }
    }


    let convertedAmount = transaction.amount * 100;

    convertedAmount = Math.round(convertedAmount);
    convertedAmount *= -1;

    return {
        account: accountId,
        date: transaction.date,
        amount: convertedAmount,
        payee_name: payee,
        imported_payee: payee,
        notes: notes,
        imported_id: transaction.transaction_id,
    }

}


const GENERIC_TRANSACTION_MAPPER = (accountId) => (transaction) => {
    //if (transaction.pending) {
    //    console.error(transaction, accountId)
    //    throw new Error("Pending transactions are not supported")
    //}

    let convertedAmount = transaction.amount * 100;

    convertedAmount = Math.round(convertedAmount);
    convertedAmount *= -1;

    return {
        account: accountId,
        date: transaction.date,
        amount: convertedAmount,
        payee_name: transaction.merchant_name || transaction.name,
        imported_payee: transaction.merchant_name || transaction.name,
        //notes: transaction.name,
        imported_id: transaction.transaction_id,
        cleared: !transaction.pending,
    }
}
const map = {
    "ABN AMRO": ABN_AMRO_TRANSACTION_MAPPER,
}

const transactionMapper = (accountId, bank) => {
    if (map[bank]) {
        return map[bank](accountId)
    } else {
        return GENERIC_TRANSACTION_MAPPER(accountId)
    }
}


const SYNC_OK_PREFIX = '✓';
const SYNC_FAIL_PREFIX = 'Ｘ';
const SYNC_PREFIX_RE = /^[✓Ｘ]\s+/;

function stripSyncPrefix(name) {
    return (name || '').replace(SYNC_PREFIX_RE, '');
}

function hasSyncPrefix(name) {
    return SYNC_PREFIX_RE.test(name || '');
}

function formatLastUpdated(date = new Date()) {
    return date.toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
    });
}

function replaceLastUpdatedStamp(note, date = new Date()) {
    const stamp = `last_updated:${formatLastUpdated(date)}`;
    const existing = note || '';
    if (/\blast_updated:[^\n]*/.test(existing)) {
        return existing.replace(/\blast_updated:[^\n]*/, stamp);
    }
    return existing ? `${existing}\n${stamp}` : stamp;
}

async function stampAccountLastUpdated(actualInstance, accountId) {
    const noteId = `account-${accountId}`;
    const row = await actualInstance.getNote(noteId);
    const existing = (row && row.note) || '';
    await actualInstance.updateNote(noteId, replaceLastUpdatedStamp(existing));
}

// Only renames accounts that already start with ✓ or Ｘ.
async function setSyncStatusPrefix(actualInstance, accountId, ok) {
    const accounts = await actualInstance.getAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account || !hasSyncPrefix(account.name)) {
        return account;
    }
    const newName = `${ok ? SYNC_OK_PREFIX : SYNC_FAIL_PREFIX} ${stripSyncPrefix(account.name)}`;
    if (newName === account.name) {
        return account;
    }
    await actualInstance.updateAccount(accountId, { name: newName });
    account.name = newName;
    console.log(`Renamed account to "${newName}"`);
    return account;
}

async function importPlaidTransactions(actualInstance, accountId, bank, transactions, balance) {
    const row = await actualInstance.getNote(`account-${accountId}`);
    const note = (row && row.note) || '';
    const isInvestment = note.includes('#Investment');

    if (isInvestment) {
        console.log("Investment account detected, skipping transaction import.");
    } else {
        const mapped = transactions.map(transactionMapper(accountId, bank));
        const actualResult = await actualInstance.importTransactions(accountId, mapped);
        console.log("Actual logs: ", actualResult);
    }

    if (balance !== null && balance !== undefined) {
        await actualInstance.updateAccount(accountId, { balance_current: balance });
        console.log("Updated balance_current to:", balance);
    }

    await stampAccountLastUpdated(actualInstance, accountId);
    await setSyncStatusPrefix(actualInstance, accountId, true);
}

async function getBalance(actualInstance, accountId) {
    const balance = await actualInstance.runQuery(q('transactions')
        .filter({ account: accountId })
        //.options({ splits: 'inline' })
        .calculate({ $sum: '$amount' }),)
    return balance.data;
}

/**
 * 
 * @param {typeof actual} actualInstance 
 */
async function finalize(actualInstance) {
    await actualInstance.sync()
    await actualInstance.shutdown();
}

module.exports = {
    initialize,
    listAccounts,
    getLastTransactionDate,
    importPlaidTransactions,
    transactionMapper,
    finalize,
    getBalance,
    setSyncStatusPrefix,
    stripSyncPrefix,
    hasSyncPrefix,
}
