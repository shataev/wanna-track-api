const router = require('express').Router();
const Cost = require('../models/Cost');
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const Category = require('../models/Category');
const { authenticate, authenticateUserOrBot } = require('../middlewares/authenticate');
const { getRatesObject } = require('../services/exchangeRateService');
const { getConversionRate, roundToCurrencyPrecision } = require('../utils/currency.utils');
const { findOwnedFund } = require('../utils/fund.utils');
const { parseObjectId } = require('../utils/id.utils');
const { normalizeTag, normalizeTags } = require('../utils/tag.utils');

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

// Get all user's costs
router.get('/costs', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const {dateFrom, dateTo, tag: rawTag} = req.query;

        // Get user's base currency
        const userCurrency = req.user.defaultCurrency || 'USD';

        const match = { user: userId };

        if (rawTag !== undefined) {
            const tag = normalizeTag(rawTag);

            // No cost can carry a tag that normalises to nothing
            if (!tag) {
                return res.status(200).json([]);
            }

            match.tags = tag;
        }

        // Without a tag the period is required, as before; with one, each bound is optional (all time)
        if (rawTag === undefined || dateFrom !== undefined || dateTo !== undefined) {
            match.date = {};

            if (rawTag === undefined || dateFrom !== undefined) {
                match.date.$gte = new Date(dateFrom);
            }

            if (rawTag === undefined || dateTo !== undefined) {
                match.date.$lt = new Date(dateTo);
            }
        }

        const costs = await Cost.aggregate([
            {
                $match: match,
            },
            {
                $lookup: {
                    from: 'categories',
                    localField: 'category',
                    foreignField: '_id',
                    as: 'category',
                },
            },
            {
                $unwind: '$category',
            },
            {
                $lookup: {
                    from: 'funds',
                    localField: 'fund',
                    foreignField: '_id',
                    as: 'fund'
                }
            },
            {
                $unwind: {
                    path: '$fund',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                // Handle old records without currency/rate: treat as user's base currency
                $addFields: {
                    currency: {
                        $ifNull: ['$currency', userCurrency]
                    },
                    rate: {
                        $ifNull: ['$rate', 1]
                    }
                }
            },
            {
                // Calculate amount in user's base currency: amount * rate
                $addFields: {
                    amountInUserCurrency: {
                        $round: [
                            {
                                $multiply: ['$amount', '$rate'] 
                            },
                            0
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: '$category._id',
                    amount: { 
                        $sum: '$amountInUserCurrency' // Sum converted amounts
                    },
                    category: {$first: '$category.name'},
                    icon: {$first: '$category.icon'},
                    costs: { 
                        $push: {
                            _id: '$_id',
                            amount: '$amount',
                            currency: '$currency',
                            rate: '$rate',
                            amountInUserCurrency: '$amountInUserCurrency',
                            comment: '$comment',
                            date: '$date',
                            createdAt: '$createdAt',
                            updatedAt: '$updatedAt',
                            fund: '$fund',
                            category: '$category',
                            tags: { $ifNull: ['$tags', []] },
                            // In the fund's currency; costs older than fundAmount were debited `amount`
                            fundAmount: {
                                $cond: [
                                    { $ifNull: ['$fund', false] },
                                    { $ifNull: ['$fundAmount', '$amount'] },
                                    null
                                ]
                            }
                        }
                    },
                }
            },
            {
                // Round the total amount to integer
                $addFields: {
                    amount: {
                        $round: ['$amount', 0]
                    },
                    currency: userCurrency // Add user's base currency to response
                }
            },
            {
                $sort: {
                    amount: -1
                }
            }
        ]);

        res
            .status(200)
            .json(costs);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }

})


// Add new cost
// `amount` and `currency` are what was spent; with a fund in another currency the fund is debited
// the converted `fundAmount`. `rate` (currency -> user's default currency) is always computed here.
router.post('/cost', authenticateUserOrBot, async (req, res) => {
    const {
        amount: rawAmount,
        category,
        comment,
        date,
        fundId,
        tags: rawTags,
        currency: rawCurrency
    } = req.body;
    const userId = req.user.id;

    try {
        const amount = parseAmount(rawAmount);

        if (amount === null) {
            return res.status(400).json({ error: 'Amount must be a positive number' });
        }

        // Absent: the user's active tag; present, even empty: exactly the tags given
        if (rawTags !== undefined && !Array.isArray(rawTags)) {
            return res.status(400).json({ error: 'Tags must be an array' });
        }

        const tags = rawTags === undefined
            ? normalizeTags(req.user.activeTag ? [req.user.activeTag] : [])
            : normalizeTags(rawTags);

        const requestedCurrency = parseCurrency(rawCurrency);

        if (requestedCurrency === undefined) {
            return res.status(400).json({ error: 'Currency must be a three-letter code' });
        }

        // Either a global category (user: null) or one of the caller's own; checked before any money moves
        const categoryId = parseObjectId(category);
        const isCategoryAllowed = categoryId && await Category.exists({
            _id: categoryId,
            user: { $in: [null, userId] }
        });

        if (!isCategoryAllowed) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const userCurrency = req.user.defaultCurrency || 'USD';
        const getRate = createRateGetter();

        let fund = null;
        let fundAmount;

        if (fundId) {
            fund = await findOwnedFund(fundId, userId);

            if (!fund) {
                return res.status(404).json({ error: 'Fund not found' });
            }
        }

        // Without a currency: the fund's, else the user's default, as before
        const currency = requestedCurrency || (fund ? fund.currency : userCurrency);

        const toUser = await getRate(currency, userCurrency);

        if (toUser.error) {
            return res.status(toUser.status).json({ error: toUser.error });
        }

        if (fund) {
            const toFund = await getRate(currency, fund.currency);

            if (toFund.error) {
                return res.status(toFund.status).json({ error: toFund.error });
            }

            fundAmount = currency === fund.currency
                ? amount
                : roundToCurrencyPrecision(amount * toFund.rate, fund.currency);

            if (fundAmount <= 0) {
                return res.status(400).json({ error: `Amount is too small to debit in ${fund.currency}` });
            }

            if (fund.currentBalance < fundAmount) {
                return res.status(400).json({ error: 'Insufficient funds' });
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
            rate: toUser.rate,
            category: categoryId,
            comment,
            date,
            user: userId,
            fund: fund ? fund._id : null,
            tags,
            fundAmount
        });

        const cost = await newCost.save();

        res
            .status(201)
            .json(cost);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// Replace the tags of one of the caller's costs; nothing else about a cost is editable here
router.patch('/cost/:id', authenticate, async (req, res) => {
    try {
        const { tags } = req.body ?? {};

        if (!Array.isArray(tags)) {
            return res.status(400).json({ error: 'Tags must be an array' });
        }

        const costId = parseObjectId(req.params.id);
        const cost = costId && await Cost.findOneAndUpdate(
            { _id: costId, user: req.user.id },
            { tags: normalizeTags(tags) },
            { new: true }
        );

        if (!cost) {
            return res.status(404).json({ error: 'Cost not found' });
        }

        res.status(200).json(cost);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// The caller's tags with their totals in the user's default currency, most recently used first
router.get('/tags', authenticateUserOrBot, async (req, res) => {
    try {
        const userCurrency = req.user.defaultCurrency || 'USD';

        const tags = await Cost.aggregate([
            {
                $match: { user: req.user.id, 'tags.0': { $exists: true } }
            },
            {
                $unwind: '$tags'
            },
            {
                // The same conversion as GET /costs
                $addFields: {
                    amountInUserCurrency: {
                        $round: [{ $multiply: ['$amount', { $ifNull: ['$rate', 1] }] }, 0]
                    }
                }
            },
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

        res.status(200).json(tags);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

module.exports = router;
