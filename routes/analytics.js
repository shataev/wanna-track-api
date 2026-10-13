const router = require('express').Router();
const { authenticate } = require('../middlewares/authenticate');
const { buildSummary, buildMonthly } = require('../services/analyticsService');

/**
 * The period [dateFrom, dateTo) as GET /costs reads it, compared with the previous calendar month
 * when the period is one Bangkok calendar month, else with the same number of days immediately
 * before dateFrom. While the period is under way, the comparison covers only as much of the previous
 * period as has elapsed of this one. All amounts are in the user's default currency.
 */
router.get('/analytics/summary', authenticate, async (req, res) => {
    try {
        const result = await buildSummary(req.user, req.query);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res.status(200).json(result.body);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to build the summary' });
    }
});

/**
 * Totals per Bangkok calendar month for the last `months` months, the current one included, oldest first.
 * A month without expenses is present with total 0.
 */
router.get('/analytics/monthly', authenticate, async (req, res) => {
    try {
        const result = await buildMonthly(req.user, req.query);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        res.status(200).json(result.body);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to build the monthly totals' });
    }
});

module.exports = router;
