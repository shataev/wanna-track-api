const router = require('express').Router();
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const User = require('../models/User');
const {checkAccessToken} = require('../middlewares/checkAuth');
const { getRates } = require('../services/exchangeRateService');
const { calculateTotalFundsAmount } = require('../utils/fund.utils');
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

// Get all user's funds
router.get('/funds', async (req, res) => {
    try {
        const userId = new ObjectId(req.query.userId);

        let funds = await Fund.find({
            userId: userId,
        })

        // Get user's base currency from database
        let userCurrency = 'USD';
        if (req.user && req.user.defaultCurrency) {
            userCurrency = req.user.defaultCurrency;
        } else {
            // If req.user is not available, get currency from database
            const user = await User.findById(userId);
            if (user && user.defaultCurrency) {
                userCurrency = user.defaultCurrency;
            }
        }

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
router.post('/funds', async (req, res) => {
    const {
        name,
        icon,
        userId,
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
            userId: userId ? new ObjectId(userId) : null
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
router.put('/funds/:id', async (req, res) => {
    const {id} = req.params;
    const {name, description, currentBalance, icon, isDefault, currency} = req.body;

    try {
        const oldFund = await Fund.findById(id);

        const fund = await Fund.findByIdAndUpdate(
            id,
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
router.delete('/funds/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const fund = await Fund.findByIdAndDelete(id);

        if (!fund) {
            return res.status(404).json({ error: 'Fund not found' });
        }

        await FundTransaction.deleteMany({ fundId: id });

        res.status(200).json({ message: 'Fund deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Transfer funds between two funds
router.post('/funds/transfer', 
    [
        checkAccessToken,
        async (req, res) => {
            const {fromFundId, toFundId, amount, description} = req.body;
            const userId = req.user.id;

            try {
                if (fromFundId === toFundId) {
                    return res.status(400).json({error: 'Funds must be different'});
                }

                // Find both funds and check ownership in a single query
                const funds = await Fund.find({
                    _id: { $in: [fromFundId, toFundId] },
                    userId
                });

                if (funds.length !== 2) {
                    return res.status(404).json({error: 'One or both funds not found or you don\'t have access to them'});
                }

                const fromFund = funds.find(fund => fund._id.toString() === fromFundId);
                const toFund = funds.find(fund => fund._id.toString() === toFundId);

                if (fromFund.currentBalance < amount) {
                    return res.status(400).json({error: 'Insufficient amount of money in source fund'});
                }

                //return res.status(200).json({message: `fromFund: ${fromFund}, toFund: ${toFund}`})

                // Create Transactions for each funds
                const outgoingTransaction = new FundTransaction({
                    userId,
                    fundId: fromFundId,
                    type: 'transfer-out',
                    amount: -amount,
                    description,
                });
                await outgoingTransaction.save();

                const incomingTransaction = new FundTransaction({
                    userId,
                    fundId: toFundId,
                    type: 'transfer-in',
                    amount,
                    description,
                });
                await incomingTransaction.save();

                // Update funds
                await Fund.findByIdAndUpdate(fromFundId, {$inc: {currentBalance: -amount}});
                await Fund.findByIdAndUpdate(toFundId, {$inc: {currentBalance: amount}});

                res.status(200).json("Transferred successfully!");
            } catch (error) {
                res.status(500).json({error: error.message});
            }
        }
    ]
);

// GET /api/funds/total — return total amount across all funds in user's base currency
router.get('/funds/total', 
    [
        checkAccessToken,
        async (req, res) => {
            try {
                const userId = new ObjectId(req.user.id);
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
router.get('/funds/:id', async (req, res) => {
    const {id} = req.params;

    try {
        const fund = await Fund.findById(id);
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
        });
    } catch (error) {
        console.error('Get fund error:', error);
        res.status(500).json({error: error.message});
    }
});

// Get all transactions for a fund
router.get('/funds/:id/transactions', async (req, res) => {
    const {id} = req.params;

    try {
        const transactions = await FundTransaction.find({fundId: id});
        res.status(200).json(transactions);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

module.exports = router;
