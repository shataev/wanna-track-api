const router = require('express').Router();
const { authenticate, authenticateUserOrBot } = require('../middlewares/authenticate');
const { listBudgets, setBudget, removeBudget } = require('../services/budgetService');

// The caller's monthly category limits with what is spent in `month` (default: the current Bangkok month).
// The bot reads them too: it prints the limit after booking an expense.
router.get('/budgets', authenticateUserOrBot, async (req, res) => {
    try {
        const result = await listBudgets(req.user, req.query);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res.status(200).json(result.body);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to load the budgets' });
    }
});

// Set or change the limit of a category, in the caller's default currency
router.put('/budgets/:categoryId', authenticate, async (req, res) => {
    try {
        const result = await setBudget(req.user, req.params.categoryId, req.body?.amount);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res.status(200).json(result.body);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to save the budget' });
    }
});

router.delete('/budgets/:categoryId', authenticate, async (req, res) => {
    try {
        const result = await removeBudget(req.user, req.params.categoryId);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res.status(204).end();
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to remove the budget' });
    }
});

module.exports = router;
