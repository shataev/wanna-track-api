const router = require('express').Router();
const Cost = require('../models/Cost');
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const Category = require('../models/Category');
const { authenticate, authenticateUserOrBot } = require('../middlewares/authenticate');
const { findOwnedFund } = require('../utils/fund.utils');
const { parseObjectId } = require('../utils/id.utils');
const { normalizeTag, normalizeTags } = require('../utils/tag.utils');
const { userCurrencyStages } = require('../utils/cost.utils');
const {
    parseAmount,
    parseCurrency,
    createRateGetter,
    priceCost,
    createCost,
    listTags
} = require('../services/costService');

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
            ...userCurrencyStages(userCurrency),
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


// Add new cost; see createCost for the rules
router.post('/cost', authenticateUserOrBot, async (req, res) => {
    try {
        const result = await createCost(req.user, req.body ?? {});

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res
            .status(201)
            .json(result.cost);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// One of the caller's costs as the edit form needs it, or null: category and fund populated,
// `fundAmount` in the fund's currency (costs older than fundAmount were debited `amount`), null without a fund
const findCostForResponse = async (costId, userId) => {
    const cost = await Cost.findOne({ _id: costId, user: userId })
        .populate('category')
        .populate('fund', 'name currency');

    if (!cost) {
        return null;
    }

    const body = cost.toJSON();

    body.tags = body.tags ?? [];
    body.fundAmount = body.fund ? (body.fundAmount ?? body.amount) : null;

    return body;
};

// What a cost debited its fund, in the fund's currency; 0 for a cost without a fund
const debitOf = (cost) => cost.fund ? (cost.fundAmount ?? cost.amount) : 0;

// A fund history line: "<prefix>: <comment or category name>", plus what was spent when it was another currency
const describeCost = async (prefix, { comment, category, amount, currency }, fund) => {
    const label = comment || (await Category.findById(category))?.name || 'Cost';
    const description = `${prefix}: ${label}`;

    return currency === fund.currency ? description : `${description} (${amount} ${currency})`;
};

// Credit a fund back with what a cost debited; the fund may have been deleted since, then there is nothing to credit
const refundFund = async (fund, debit, description) => {
    if (!fund) {
        return;
    }

    await Fund.updateOne({ _id: fund._id }, { $inc: { currentBalance: debit } });
    await FundTransaction.create({
        userId: fund.userId,
        fundId: fund._id,
        type: 'refund',
        amount: debit,
        description
    });
};

// One of the caller's costs, for the edit form
router.get('/cost/:id', authenticate, async (req, res) => {
    try {
        const costId = parseObjectId(req.params.id);
        const cost = costId && await findCostForResponse(costId, req.user.id);

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

/**
 * Edit one of the caller's costs. Every field is optional: amount, currency, fundId (null: no fund), category,
 * date, comment, tags; anything else is ignored. When amount, currency or fund change, the old fund is credited
 * back and the new one debited, each with its own history line; everything is validated before anything is
 * written. The writes are not atomic: the refund comes first, so an interrupted edit leaves the money with the user.
 */
router.patch('/cost/:id', authenticate, async (req, res) => {
    try {
        const body = req.body ?? {};
        const userId = req.user.id;
        const userCurrency = req.user.defaultCurrency || 'USD';

        const costId = parseObjectId(req.params.id);
        const cost = costId && await Cost.findOne({ _id: costId, user: userId });

        if (!cost) {
            return res.status(404).json({ error: 'Cost not found' });
        }

        const update = {};

        if (body.tags !== undefined) {
            if (!Array.isArray(body.tags)) {
                return res.status(400).json({ error: 'Tags must be an array' });
            }

            update.tags = normalizeTags(body.tags);
        }

        if (body.comment !== undefined) {
            if (body.comment !== null && typeof body.comment !== 'string') {
                return res.status(400).json({ error: 'Comment must be a string' });
            }

            update.comment = body.comment ?? '';
        }

        if (body.date !== undefined) {
            const date = body.date === null ? null : new Date(body.date);

            if (!date || Number.isNaN(date.getTime())) {
                return res.status(400).json({ error: 'Date is invalid' });
            }

            update.date = date;
        }

        if (body.category !== undefined) {
            const categoryId = parseObjectId(body.category);
            const isCategoryAllowed = categoryId && await Category.exists({
                _id: categoryId,
                user: { $in: [null, userId] }
            });

            if (!isCategoryAllowed) {
                return res.status(404).json({ error: 'Category not found' });
            }

            update.category = categoryId;
        }

        let amount = cost.amount;

        if (body.amount !== undefined) {
            amount = parseAmount(body.amount);

            if (amount === null) {
                return res.status(400).json({ error: 'Amount must be a positive number' });
            }
        }

        // Costs saved before currency and rate existed are in the default currency at rate 1, as everywhere else;
        // saving the edit needs both, as the schema requires them
        if (!cost.currency) {
            cost.currency = userCurrency;
        }

        if (cost.rate === undefined || cost.rate === null) {
            cost.rate = 1;
        }

        const oldCurrency = cost.currency;
        let currency = oldCurrency;

        if (body.currency !== undefined && body.currency !== null && body.currency !== '') {
            currency = parseCurrency(body.currency);

            if (currency === undefined) {
                return res.status(400).json({ error: 'Currency must be a three-letter code' });
            }
        }

        // The fund the cost is moved to: absent keeps the current one, null or '' takes it off any fund
        const oldFundId = cost.fund ? String(cost.fund) : null;
        const newFundId = body.fundId === undefined
            ? oldFundId
            : (body.fundId === null || body.fundId === '' ? null : String(body.fundId));

        const movesMoney = amount !== cost.amount || currency !== oldCurrency || newFundId !== oldFundId;

        if (movesMoney) {
            const newFund = newFundId ? await findOwnedFund(newFundId, userId) : null;

            if (newFundId && !newFund) {
                return res.status(404).json({ error: 'Fund not found' });
            }

            // The rate is the one on the day of the expense; only another currency needs a new one
            const price = await priceCost({
                amount,
                currency,
                fund: newFund,
                userCurrency,
                getRate: createRateGetter(),
                rate: currency === oldCurrency ? cost.rate : undefined
            });

            if (price.error) {
                return res.status(price.status).json({ error: price.error });
            }

            const oldDebit = debitOf(cost);
            const isSameFund = newFund !== null && String(newFund._id) === oldFundId;

            // Staying in the same fund, the old debit comes back before the new one goes out
            if (newFund && newFund.currentBalance + (isSameFund ? oldDebit : 0) < price.fundAmount) {
                return res.status(400).json({ error: 'Insufficient funds' });
            }

            const oldFund = isSameFund ? newFund : (oldFundId && await Fund.findOne({ _id: oldFundId, userId }));
            const edited = {
                comment: update.comment ?? cost.comment,
                category: update.category ?? cost.category
            };

            if (oldFund) {
                await refundFund(
                    oldFund,
                    oldDebit,
                    await describeCost('Edited', { ...edited, amount: cost.amount, currency: oldCurrency }, oldFund)
                );
            }

            if (newFund) {
                await Fund.updateOne({ _id: newFund._id }, { $inc: { currentBalance: -price.fundAmount } });
                await FundTransaction.create({
                    userId: new ObjectId(userId),
                    fundId: newFund._id,
                    type: 'expense',
                    amount: -price.fundAmount,
                    description: await describeCost('Edited', { ...edited, amount, currency }, newFund)
                });
            }

            Object.assign(update, {
                amount,
                currency,
                rate: price.rate,
                fund: newFund ? newFund._id : null,
                fundAmount: price.fundAmount
            });
        }

        cost.set(update);
        await cost.save();

        res.status(200).json(await findCostForResponse(cost._id, userId));
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// Delete one of the caller's costs; what it debited goes back to its fund, if the fund still exists
router.delete('/cost/:id', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const costId = parseObjectId(req.params.id);
        const cost = costId && await Cost.findOne({ _id: costId, user: userId });

        if (!cost) {
            return res.status(404).json({ error: 'Cost not found' });
        }

        const fund = cost.fund && await Fund.findOne({ _id: cost.fund, userId });

        if (fund) {
            const { comment, category, amount } = cost;
            const currency = cost.currency || req.user.defaultCurrency || 'USD';

            await refundFund(fund, debitOf(cost), await describeCost('Deleted', { comment, category, amount, currency }, fund));
        }

        await Cost.deleteOne({ _id: cost._id });

        res.status(204).end();
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
        res.status(200).json(await listTags(req.user));
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

module.exports = router;
