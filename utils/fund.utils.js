const Fund = require('../models/Fund');
const { getRates } = require('../services/exchangeRateService');
const { parseObjectId } = require('./id.utils');
const { BANGKOK_OFFSET_MS } = require('../services/analyticsService');

/**
 * The fund with this id if it belongs to the user, otherwise null (also for a malformed id),
 * so a caller cannot tell someone else's fund from one that does not exist
 */
async function findOwnedFund(id, userId) {
    const fundId = parseObjectId(id);

    if (!fundId) {
        return null;
    }

    return Fund.findOne({ _id: fundId, userId });
}

/**
 * Calculates the total amount across all user's active (not archived) funds in the user's base currency
 * @param {string|ObjectId} userId - User ID
 * @param {string} userCurrency - User's base currency (e.g., 'USD', 'THB')
 * @returns {Promise<{total: number, baseCurrency: string, fundsCount: number}|null>} - Object with total amount, currency and funds count, or null if exchange rates are not found
 */
async function calculateTotalFundsAmount(userId, userCurrency = 'USD') {
    try {
        // Get all user funds
        // Archived funds do not count in the total
        const funds = await Fund.find({ userId, archivedAt: null });

        if (funds.length === 0) {
            return {
                total: 0,
                available: 0,
                saved: 0,
                baseCurrency: userCurrency,
                fundsCount: 0
            };
        }

        // Get exchange rates
        const exchangeRates = await getRates();
        
        if (!exchangeRates) {
            return null; // Exchange rates not found
        }

        // Convert Map to object for easier handling
        const rates = {};
        if (exchangeRates.rates instanceof Map) {
            exchangeRates.rates.forEach((value, key) => {
                rates[key] = value;
            });
        } else {
            Object.assign(rates, exchangeRates.rates);
        }

        const systemBaseCurrency = exchangeRates.base; // Usually USD
        let totalInSystemBase = 0; // Total amount in system base currency (USD)
        let accountsInSystemBase = 0; // The part of it held in accounts, the rest is savings

        // Convert each balance to system base currency (USD)
        for (const fund of funds) {
            const fundCurrency = fund.currency;
            const fundBalance = fund.currentBalance;

            if (fundCurrency === systemBaseCurrency) {
                // If fund currency matches system base currency, just add the balance
                totalInSystemBase += fundBalance;
                if (fund.kind !== 'savings') accountsInSystemBase += fundBalance;
            } else {
                // Convert to system base currency
                // Rate is stored as: 1 system base currency = X target currency
                // So for conversion: balance / rate
                const rate = rates[fundCurrency];
                
                if (!rate) {
                    console.warn(`Exchange rate not found for currency: ${fundCurrency}`);
                    // If rate not found, skip this fund
                    continue;
                }

                const convertedBalance = fundBalance / rate;
                totalInSystemBase += convertedBalance;
                if (fund.kind !== 'savings') accountsInSystemBase += convertedBalance;
            }
        }

        // Now convert from system base currency to user currency
        let total = totalInSystemBase;
        let available = accountsInSystemBase;

        if (userCurrency !== systemBaseCurrency) {
            const userCurrencyRate = rates[userCurrency];
            if (!userCurrencyRate) {
                console.warn(`Exchange rate not found for user currency: ${userCurrency}`);
                // If rate not found, return in system base currency
                total = totalInSystemBase;
                available = accountsInSystemBase;
            } else {
                // Convert: amount in USD * user currency rate
                total = totalInSystemBase * userCurrencyRate;
                available = accountsInSystemBase * userCurrencyRate;
            }
        }

        const roundedTotal = Math.round(total * 100) / 100; // Round to 2 decimal places
        const roundedAvailable = Math.round(available * 100) / 100;

        return {
            total: roundedTotal,
            // Saved is what is left of the total, so available + saved is exactly the total whatever the rounding
            available: roundedAvailable,
            saved: Math.round((roundedTotal - roundedAvailable) * 100) / 100,
            baseCurrency: userCurrency,
            fundsCount: funds.length
        };
    } catch (error) {
        console.error('Error calculating total funds:', error);
        throw error;
    }
}

// A fund that is archived takes no new money: not an expense, not a transfer, not the default
const isArchived = (fund) => Boolean(fund && fund.archivedAt);

const FUND_KINDS = ['account', 'savings'];

/**
 * Reads a goal from a request body: undefined (not sent), null (clear) or { amount, date }.
 * @returns {{ error: string }|{ value: null|{ amount: number, date: Date|null } }}
 */
function parseGoal(goal) {
    if (goal === null) {
        return { value: null };
    }

    if (typeof goal !== 'object' || Array.isArray(goal)) {
        return { error: 'Goal must be an object or null' };
    }

    const { amount, date } = goal;
    const number = typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '') ? Number(amount) : NaN;

    if (!Number.isFinite(number) || number <= 0) {
        return { error: 'Goal amount must be a positive number' };
    }

    if (date === undefined || date === null || date === '') {
        return { value: { amount: number, date: null } };
    }

    const parsed = typeof date === 'string' || typeof date === 'number' ? new Date(date) : null;

    if (!parsed || Number.isNaN(parsed.getTime())) {
        return { error: 'Goal date is not a valid date' };
    }

    return { value: { amount: number, date: parsed } };
}

// Whole Asia/Bangkok calendar months, as year * 12 + month index
const bangkokMonthIndex = (date) => {
    const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MS);
    return shifted.getUTCFullYear() * 12 + shifted.getUTCMonth();
};

/**
 * Progress of a fund's goal, or null when it has none.
 * monthsLeft counts Bangkok calendar months from the current one up to and including the target date's month, at least 1:
 * a target date in the past (or in this month) therefore still gives 1, i.e. "all of the remainder this month".
 */
function goalProgress(fund, now = Date.now()) {
    if (!fund.goal || !fund.goal.amount) {
        return null;
    }

    const { amount, date } = fund.goal;
    const remaining = Math.max(amount - fund.currentBalance, 0);
    let monthsLeft = null;
    let perMonth = null;

    if (date) {
        monthsLeft = Math.max(bangkokMonthIndex(date) - bangkokMonthIndex(new Date(now)) + 1, 1);
        // Rounded up to whole units; the epsilon keeps float noise from adding a unit
        perMonth = Math.max(Math.ceil(remaining / monthsLeft - 1e-9), 0);
    }

    return {
        percent: fund.currentBalance / amount * 100,
        remaining,
        monthsLeft,
        perMonth,
        reached: fund.currentBalance >= amount
    };
}

// A fund as the API returns it: its own fields, a kind even for old documents, and the goal progress when it has a goal
function serializeFund(fund, now = Date.now()) {
    const plain = fund.toJSON();
    const progress = goalProgress(fund, now);

    return {
        ...plain,
        kind: fund.kind || 'account',
        goal: plain.goal ?? null,
        ...(progress ? { goalProgress: progress } : {})
    };
}

module.exports = {
    FUND_KINDS,
    parseGoal,
    goalProgress,
    serializeFund,
    isArchived,
    calculateTotalFundsAmount,
    findOwnedFund
};
