const mongoose = require('mongoose');
const ObjectId = mongoose.Types.ObjectId;
const Cost = require('../models/Cost');
const FundTransaction = require('../models/FundTransaction');
const Category = require('../models/Category');
const { getRatesObject } = require('./exchangeRateService');
const { getConversionRate, roundToCurrencyPrecision } = require('../utils/currency.utils');
const { findOwnedFund } = require('../utils/fund.utils');
const { parseObjectId } = require('../utils/id.utils');
const { normalizeTags } = require('../utils/tag.utils');
const { userCurrencyStages } = require('../utils/cost.utils');

// A positive finite amount from a number or a numeric string (the web form sends strings), otherwise null
const parseAmount = (value) => {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
        return null;
    }

    const amount = Number(value);

    return Number.isFinite(amount) && amount > 0 ? amount : null;
};

// The requested currency: null when absent, an upper-case code, or undefined when it cannot be one
const parseCurrency = (value) => {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (typeof value !== 'string') {
        return undefined;
    }

    const code = value.trim().toUpperCase();

    return /^[A-Z]{3}$/.test(code) ? code : undefined;
};

/**
 * getRate(from, to) resolves to { rate } or to { status, error } for the response.
 * The stored rates are read once, and only when two currencies actually differ.
 */
const createRateGetter = () => {
    let exchangeRates;

    return async (from, to) => {
        if (from === to) {
            return { rate: 1 };
        }

        if (exchangeRates === undefined) {
            exchangeRates = await getRatesObject();
        }

        if (!exchangeRates) {
            return { status: 404, error: 'Exchange rates not found. Please update rates first.' };
        }

        const { rates, base } = exchangeRates;
        const rate = getConversionRate(from, to, rates, base);

        if (!rate) {
            const missing = from !== base && !rates[from] ? from : to;

            return { status: 400, error: `Exchange rate not found for currency: ${missing}` };
        }

        return { rate };
    };
};

/**
 * What a cost of `amount` in `currency` is worth: `rate` (currency -> user's default currency) and, with a fund,
 * `fundAmount`, what the fund is debited in its own currency. A `rate` passed in is kept rather than looked up.
 * Resolves to { rate, fundAmount } or to { status, error } for the response. Used by every route that debits.
 */
const priceCost = async ({ amount, currency, fund, userCurrency, getRate, rate }) => {
    const toUser = rate === undefined ? await getRate(currency, userCurrency) : { rate };

    if (toUser.error) {
        return toUser;
    }

    if (!fund) {
        return { rate: toUser.rate, fundAmount: undefined };
    }

    const toFund = await getRate(currency, fund.currency);

    if (toFund.error) {
        return toFund;
    }

    const fundAmount = currency === fund.currency
        ? amount
        : roundToCurrencyPrecision(amount * toFund.rate, fund.currency);

    if (fundAmount <= 0) {
        return { status: 400, error: `Amount is too small to debit in ${fund.currency}` };
    }

    return { rate: toUser.rate, fundAmount };
};

/**
 * A new cost for `user` (the shape of req.user), as POST /api/cost and the MCP add_expense tool create one.
 * `amount` and `currency` are what was spent; with a fund in another currency the fund is debited
 * the converted `fundAmount`. `rate` (currency -> user's default currency) is always computed here.
 * Resolves to { cost, fund } or to { status, error } for the response; nothing is written on an error.
 */
const createCost = async (user, {
    amount: rawAmount,
    category,
    comment,
    date,
    fundId,
    tags: rawTags,
    currency: rawCurrency
}) => {
    const userId = user.id;
    const amount = parseAmount(rawAmount);

    if (amount === null) {
        return { status: 400, error: 'Amount must be a positive number' };
    }

    // Absent: the user's active tag; present, even empty: exactly the tags given
    if (rawTags !== undefined && !Array.isArray(rawTags)) {
        return { status: 400, error: 'Tags must be an array' };
    }

    const tags = rawTags === undefined
        ? normalizeTags(user.activeTag ? [user.activeTag] : [])
        : normalizeTags(rawTags);

    const requestedCurrency = parseCurrency(rawCurrency);

    if (requestedCurrency === undefined) {
        return { status: 400, error: 'Currency must be a three-letter code' };
    }

    // Either a global category (user: null) or one of the caller's own; checked before any money moves
    const categoryId = parseObjectId(category);
    const isCategoryAllowed = categoryId && await Category.exists({
        _id: categoryId,
        user: { $in: [null, userId] }
    });

    if (!isCategoryAllowed) {
        return { status: 404, error: 'Category not found' };
    }

    const userCurrency = user.defaultCurrency || 'USD';

    let fund = null;

    if (fundId) {
        fund = await findOwnedFund(fundId, userId);

        if (!fund) {
            return { status: 404, error: 'Fund not found' };
        }
    }

    // Without a currency: the fund's, else the user's default, as before
    const currency = requestedCurrency || (fund ? fund.currency : userCurrency);

    const price = await priceCost({ amount, currency, fund, userCurrency, getRate: createRateGetter() });

    if (price.error) {
        return price;
    }

    const { fundAmount } = price;

    if (fund) {
        if (fund.currentBalance < fundAmount) {
            return { status: 400, error: 'Insufficient funds' };
        }

        // Update fund balance
        fund.currentBalance -= fundAmount;
        await fund.save();

        const description = comment || 'Cost payment';

        // Create fund transaction record
        const fundTransaction = new FundTransaction({
            userId: new ObjectId(userId),
            fundId: fund._id,
            type: 'expense',
            amount: -fundAmount,
            description: currency === fund.currency ? description : `${description} (${amount} ${currency})`
        });
        await fundTransaction.save();
    }

    // Create new cost
    const newCost = new Cost({
        amount,
        currency,
        rate: price.rate,
        category: categoryId,
        comment,
        date,
        user: userId,
        fund: fund ? fund._id : null,
        tags,
        fundAmount
    });

    const cost = await newCost.save();

    return { cost, fund };
};

// The caller's tags with their totals in the user's default currency, most recently used first (GET /api/tags)
const listTags = (user) => {
    const userCurrency = user.defaultCurrency || 'USD';

    return Cost.aggregate([
        {
            $match: { user: user.id, 'tags.0': { $exists: true } }
        },
        {
            $unwind: '$tags'
        },
        ...userCurrencyStages(userCurrency),
        {
            $group: {
                _id: '$tags',
                count: { $sum: 1 },
                total: { $sum: '$amountInUserCurrency' },
                firstDate: { $min: '$date' },
                lastDate: { $max: '$date' }
            }
        },
        {
            $sort: { lastDate: -1, _id: 1 }
        },
        {
            $project: {
                _id: 0,
                tag: '$_id',
                count: 1,
                total: { $round: ['$total', 0] },
                currency: { $literal: userCurrency },
                firstDate: 1,
                lastDate: 1
            }
        }
    ]);
};

/**
 * The caller's costs, newest first, each with its category, fund and amountInUserCurrency: the joins of
 * GET /api/costs, so a cost whose category is gone is left out here too. Every filter is optional:
 * `from`/`to` (Dates, [from, to)), `tag` (stored form), `categoryId`, `fundId`, `costId` (ObjectIds), `limit`.
 */
const listCosts = (user, { from, to, tag, categoryId, fundId, costId, limit } = {}) => {
    const match = { user: user.id };

    if (from || to) {
        match.date = {};

        if (from) {
            match.date.$gte = from;
        }

        if (to) {
            match.date.$lt = to;
        }
    }

    if (tag) {
        match.tags = tag;
    }

    if (categoryId) {
        match.category = categoryId;
    }

    if (fundId) {
        match.fund = fundId;
    }

    if (costId) {
        match._id = costId;
    }

    return Cost.aggregate([
        { $match: match },
        { $sort: { date: -1, _id: -1 } },
        { $lookup: { from: 'categories', localField: 'category', foreignField: '_id', as: 'category' } },
        { $unwind: '$category' },
        { $lookup: { from: 'funds', localField: 'fund', foreignField: '_id', as: 'fund' } },
        { $unwind: { path: '$fund', preserveNullAndEmptyArrays: true } },
        ...(limit ? [{ $limit: limit }] : []),
        ...userCurrencyStages(user.defaultCurrency || 'USD'),
        {
            $project: {
                date: 1,
                amount: 1,
                currency: 1,
                amountInUserCurrency: 1,
                comment: 1,
                tags: { $ifNull: ['$tags', []] },
                category: { _id: 1, name: 1, icon: 1 },
                fund: { _id: 1, name: 1, currency: 1 },
                // In the fund's currency; costs older than fundAmount were debited `amount`
                fundAmount: {
                    $cond: [{ $ifNull: ['$fund', false] }, { $ifNull: ['$fundAmount', '$amount'] }, null]
                }
            }
        }
    ]);
};

module.exports = {
    listCosts,
    parseAmount,
    parseCurrency,
    createRateGetter,
    priceCost,
    createCost,
    listTags
};
