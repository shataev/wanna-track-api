const Fund = require('../models/Fund');
const { getRates } = require('../services/exchangeRateService');

/**
 * Calculates the total amount across all user funds in the user's base currency
 * @param {string|ObjectId} userId - User ID
 * @param {string} userCurrency - User's base currency (e.g., 'USD', 'THB')
 * @returns {Promise<{total: number, baseCurrency: string, fundsCount: number}|null>} - Object with total amount, currency and funds count, or null if exchange rates are not found
 */
async function calculateTotalFundsAmount(userId, userCurrency = 'USD') {
    try {
        // Get all user funds
        const funds = await Fund.find({ userId });

        if (funds.length === 0) {
            return {
                total: 0,
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

        // Convert each balance to system base currency (USD)
        for (const fund of funds) {
            const fundCurrency = fund.currency;
            const fundBalance = fund.currentBalance;

            if (fundCurrency === systemBaseCurrency) {
                // If fund currency matches system base currency, just add the balance
                totalInSystemBase += fundBalance;
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
            }
        }

        // Now convert from system base currency to user currency
        let total = totalInSystemBase;

        if (userCurrency !== systemBaseCurrency) {
            const userCurrencyRate = rates[userCurrency];
            if (!userCurrencyRate) {
                console.warn(`Exchange rate not found for user currency: ${userCurrency}`);
                // If rate not found, return in system base currency
                total = totalInSystemBase;
            } else {
                // Convert: amount in USD * user currency rate
                total = totalInSystemBase * userCurrencyRate;
            }
        }

        return {
            total: Math.round(total * 100) / 100, // Round to 2 decimal places
            baseCurrency: userCurrency,
            fundsCount: funds.length
        };
    } catch (error) {
        console.error('Error calculating total funds:', error);
        throw error;
    }
}

module.exports = {
    calculateTotalFundsAmount
};
