/**
 * Aggregation stages that give every cost its `amountInUserCurrency`: `amount × rate`, rounded to an integer.
 * Old records without currency/rate are treated as the user's default currency at rate 1.
 *
 * Every route that reports amounts in the user's currency (the Expenses page, tags, analytics) uses these
 * stages, so the numbers on different pages can never disagree.
 *
 * @param {string} userCurrency - the user's default currency
 * @returns {Object[]} stages to append after a $match on costs
 */
const userCurrencyStages = (userCurrency) => [
    {
        $addFields: {
            currency: { $ifNull: ['$currency', userCurrency] },
            rate: { $ifNull: ['$rate', 1] }
        }
    },
    {
        $addFields: {
            amountInUserCurrency: { $round: [{ $multiply: ['$amount', '$rate'] }, 0] }
        }
    }
];

module.exports = { userCurrencyStages };
