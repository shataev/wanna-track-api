const router = require('express').Router();
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const { authenticate, authenticateUserOrBot } = require('../middlewares/authenticate');
const { createFund, updateFund, deleteFund, setFundArchived, transferFunds } = require('../services/fundService');
const { serializeFund, calculateTotalFundsAmount, findOwnedFund } = require('../utils/fund.utils');

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

            return res.status(200).json({ funds: archivedFunds.map(fund => serializeFund(fund)) });
        }

        const funds = await Fund.find({ userId, archivedAt: null });

        // Get user's base currency
        const userCurrency = req.user.defaultCurrency || 'USD';

        // Calculate total amount across all funds
        const totalFunds = await calculateTotalFundsAmount(userId, userCurrency);

        res
            .status(200)
            .json({
                funds: funds.map(fund => serializeFund(fund)),
                total: totalFunds ? {
                    amount: totalFunds.total,
                    available: totalFunds.available,
                    saved: totalFunds.saved,
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
    try {
        const result = await createFund(req.user, req.body ?? {});

        if (result.error) {
            return res.status(result.status).json({error: result.error});
        }

        res
            .status(201)
            .json(serializeFund(result.fund));
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// Update fund
router.put('/funds/:id', authenticate, async (req, res) => {
    try {
        const result = await updateFund(req.user, req.params.id, req.body ?? {});

        if (result.error) {
            return res.status(result.status).json({error: result.error});
        }

        res.status(200).json(serializeFund(result.fund));
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// Delete fund
router.delete('/funds/:id', authenticate, async (req, res) => {
    try {
        const result = await deleteFund(req.user, req.params.id);

        if (result.error) {
            return res.status(result.status).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
        }

        res.status(200).json({ message: 'Fund deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Archive / restore a fund: the money and the history stay, only the listing and the total change. Idempotent
const setArchived = (archive) => async (req, res) => {
    try {
        const result = await setFundArchived(req.user, req.params.id, archive);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res.status(200).json(result.fund);
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
            try {
                const result = await transferFunds(req.user, req.body ?? {});

                if (result.error) {
                    return res.status(result.status).json({error: result.error});
                }

                res.status(200).json(result.body);
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
            ...(({ kind, goal, goalProgress }) => ({ kind, goal, ...(goalProgress ? { goalProgress } : {}) }))(serializeFund(fund)),
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
