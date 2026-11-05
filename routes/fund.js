const router = require('express').Router();
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const Cost = require('../models/Cost');
const { authenticate, authenticateUserOrBot } = require('../middlewares/authenticate');
const { getRatesObject } = require('../services/exchangeRateService');
const { calculateTotalFundsAmount, findOwnedFund, isArchived } = require('../utils/fund.utils');
const { getConversionRate, roundToCurrencyPrecision } = require('../utils/currency.utils');
const { parseObjectId } = require('../utils/id.utils');

// Get the user's active funds and their total; ?archived=true lists the archived ones instead (user only)
router.get('/funds', authenticateUserOrBot, async (req, res) => {
    try {
        const userId = req.user.id;

        // The archive is for the web only: the bot sees active funds, as before
        if (req.query.archived === 'true') {
            if (req.auth !== 'user') {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const archivedFunds = await Fund.find({ userId, archivedAt: { $ne: null } }).sort({ archivedAt: -1 });

            return res.status(200).json({ funds: archivedFunds });
        }

        const funds = await Fund.find({ userId, archivedAt: null });

        // Get user's base currency
        const userCurrency = req.user.defaultCurrency || 'USD';

        // Calculate total amount across all funds
        const totalFunds = await calculateTotalFundsAmount(userId, userCurrency);

        res
            .status(200)
            .json({
                funds,
                total: totalFunds ? {
                    amount: totalFunds.total,
                    currency: totalFunds.baseCurrency,
                    fundsCount: totalFunds.fundsCount
                } : null
            });
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }

})


// Add new fund
router.post('/funds', authenticate, async (req, res) => {
    const {
        name,
        icon,
        description,
        initialBalance,
        isDefault,
        currency
    } = req.body;

    try {
        const newFund = new Fund({
            name,
            icon,
            description,
            initialBalance,
            currentBalance: initialBalance,
            isDefault,
            currency,
            userId: req.user.id
        });

        const fund = await newFund.save();

        res
            .status(201)
            .json(fund);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// Update fund
router.put('/funds/:id', authenticate, async (req, res) => {
    const {id} = req.params;
    const {name, description, currentBalance, icon, isDefault, currency} = req.body;

    try {
        const oldFund = await findOwnedFund(id, req.user.id);

        if (!oldFund) {
            return res.status(404).json({error: 'Fund is not found'});
        }

        if (isDefault && isArchived(oldFund)) {
            return res.status(400).json({error: 'Fund is archived'});
        }

        const fund = await Fund.findOneAndUpdate(
            {_id: oldFund._id, userId: req.user.id},
            {name, description, currentBalance, icon, isDefault, currency},
            {new: true}
        );

        if (!fund) {
            return res.status(404).json({error: 'Fund is not found'});
        }

        // Create Transaction to adjust the balance
        const adjustment = new FundTransaction({
            userId: fund.userId,
            fundId: fund.id,
            type: 'adjustment',
            amount: fund.currentBalance - oldFund.currentBalance,
            description: 'Manual adjustment',
        });
        await adjustment.save();

        res.status(200).json(fund);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// Delete fund
router.delete('/funds/:id', authenticate, async (req, res) => {
    try {
        const owned = await findOwnedFund(req.params.id, req.user.id);

        if (!owned) {
            return res.status(404).json({ error: 'Fund not found' });
        }

        // Only a fund with no history can go: no cost on it and no transaction (creating a fund writes none)
        const [cost, transaction] = await Promise.all([
            Cost.exists({ fund: owned._id }),
            FundTransaction.exists({ fundId: owned._id })
        ]);

        if (cost || transaction) {
            return res.status(409).json({
                error: 'The fund has history; archive it instead',
                code: 'fund_has_history'
            });
        }

        const fund = await Fund.findOneAndDelete({ _id: owned._id, userId: req.user.id });

        if (!fund) {
            return res.status(404).json({ error: 'Fund not found' });
        }

        await FundTransaction.deleteMany({ fundId: fund._id });

        res.status(200).json({ message: 'Fund deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Archive / restore a fund: the money and the history stay, only the listing and the total change. Idempotent
const setArchived = (archive) => async (req, res) => {
    try {
        const fund = await findOwnedFund(req.params.id, req.user.id);

        if (!fund) {
            return res.status(404).json({ error: 'Fund not found' });
        }

        // Already in the requested state: nothing to change, and an archive keeps its original date
        if (isArchived(fund) === archive) {
            return res.status(200).json(fund);
        }

        const update = archive
            ? { $set: { archivedAt: new Date(), isDefault: false } }
            : { $set: { archivedAt: null } };

        const updated = await Fund.findOneAndUpdate({ _id: fund._id, userId: req.user.id }, update, { new: true });

        res.status(200).json(updated);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

router.post('/funds/:id/archive', authenticate, setArchived(true));
router.post('/funds/:id/restore', authenticate, setArchived(false));

// Transfer funds between two funds
router.post('/funds/transfer', 
    [
        authenticate,
        async (req, res) => {
            const {fromFundId, toFundId, amount, description} = req.body;
            const userId = req.user.id;

            try {
                if (fromFundId === toFundId) {
                    return res.status(400).json({error: 'Funds must be different'});
                }

                const withdrawnAmount = Number(amount);

                if (!Number.isFinite(withdrawnAmount) || withdrawnAmount <= 0) {
                    return res.status(400).json({error: 'Amount must be a positive number'});
                }

                // A malformed id is treated like someone else's fund instead of failing the cast with a 500
                const fromId = parseObjectId(fromFundId);
                const toId = parseObjectId(toFundId);

                // Find both funds and check ownership in a single query
                const funds = fromId && toId ? await Fund.find({
                    _id: { $in: [fromId, toId] },
                    userId
                }) : [];

                if (funds.length !== 2) {
                    return res.status(404).json({error: 'One or both funds not found or you don\'t have access to them'});
                }

                const fromFund = funds.find(fund => fund._id.equals(fromId));
                const toFund = funds.find(fund => fund._id.equals(toId));

                if (isArchived(fromFund) || isArchived(toFund)) {
                    return res.status(400).json({error: 'An archived fund cannot take part in a transfer'});
                }

                if (fromFund.currentBalance < withdrawnAmount) {
                    return res.status(400).json({error: 'Insufficient amount of money in source fund'});
                }

                // Сумма вводится в валюте фонда-источника, а зачислять её надо
                // в валюте фонда-получателя
                let creditedAmount = withdrawnAmount;
                let rate = 1;

                if (fromFund.currency !== toFund.currency) {
                    const exchangeRates = await getRatesObject();

                    if (!exchangeRates) {
                        return res.status(404).json({
                            error: 'Exchange rates not found. Please update rates first.'
                        });
                    }

                    rate = getConversionRate(
                        fromFund.currency,
                        toFund.currency,
                        exchangeRates.rates,
                        exchangeRates.base
                    );

                    if (!rate) {
                        return res.status(400).json({
                            error: `Exchange rate not found for ${fromFund.currency} -> ${toFund.currency}`
                        });
                    }

                    creditedAmount = roundToCurrencyPrecision(withdrawnAmount * rate, toFund.currency);

                    // Донг дешевле бата в тысячи раз, поэтому мелкая сумма
                    // после округления может превратиться в ноль
                    if (creditedAmount <= 0) {
                        return res.status(400).json({
                            error: `Amount is too small to transfer to ${toFund.currency}`
                        });
                    }
                }

                // Create Transactions for each funds
                const outgoingTransaction = new FundTransaction({
                    userId,
                    fundId: fromFundId,
                    type: 'transfer-out',
                    amount: -withdrawnAmount,
                    description,
                });
                await outgoingTransaction.save();

                const incomingTransaction = new FundTransaction({
                    userId,
                    fundId: toFundId,
                    type: 'transfer-in',
                    amount: creditedAmount,
                    description,
                });
                await incomingTransaction.save();

                // Update funds
                await Fund.findOneAndUpdate({_id: fromFundId, userId}, {$inc: {currentBalance: -withdrawnAmount}});
                await Fund.findOneAndUpdate({_id: toFundId, userId}, {$inc: {currentBalance: creditedAmount}});

                res.status(200).json({
                    message: 'Transferred successfully!',
                    withdrawn: { amount: withdrawnAmount, currency: fromFund.currency },
                    credited: { amount: creditedAmount, currency: toFund.currency },
                    rate
                });
            } catch (error) {
                res.status(500).json({error: error.message});
            }
        }
    ]
);

// GET /api/funds/total — return total amount across all funds in user's base currency
router.get('/funds/total', 
    [
        authenticate,
        async (req, res) => {
            try {
                const userId = req.user.id;
                const userCurrency = req.user.defaultCurrency || 'USD';

                const totalFunds = await calculateTotalFundsAmount(userId, userCurrency);

                if (!totalFunds) {
                    return res.status(404).json({
                        error: 'Exchange rates not found. Please update rates first.'
                    });
                }

                res.status(200).json(totalFunds);
            } catch (error) {
                console.error('Error calculating total funds:', error);
                res.status(500).json({
                    error: 'Failed to calculate total funds',
                    message: error.message
                });
            }
        }
    ]);

// GET /api/funds/:id
router.get('/funds/:id', authenticate, async (req, res) => {
    const {id} = req.params;

    try {
        const fund = await findOwnedFund(id, req.user.id);
        if (!fund) {
            return res.status(404).json({error: 'Fund is not found'});
        }

        res.json({
            id: fund._id,
            name: fund.name,
            icon: fund.icon,
            description: fund.description,
            initialBalance: fund.initialBalance,
            currentBalance: fund.currentBalance,
            createdAt: fund.createdAt,
            updatedAt: fund.updatedAt,
            isDefault: fund.isDefault,
            currency: fund.currency,
            archivedAt: fund.archivedAt ?? null,
        });
    } catch (error) {
        console.error('Get fund error:', error);
        res.status(500).json({error: error.message});
    }
});

// Get all transactions for a fund
router.get('/funds/:id/transactions', authenticate, async (req, res) => {
    const {id} = req.params;

    try {
        const fund = await findOwnedFund(id, req.user.id);

        if (!fund) {
            return res.status(404).json({error: 'Fund is not found'});
        }

        const transactions = await FundTransaction.find({fundId: fund._id});
        res.status(200).json(transactions);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

module.exports = router;
