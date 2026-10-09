const router = require('express').Router();
const Cost = require('../models/Cost');
const { authenticate } = require('../middlewares/authenticate');
const { userCurrencyStages } = require('../utils/cost.utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 400;
const TOP_SIZE = 10;
const NO_FUND_NAME = 'No account';

// Month boundaries are in Asia/Bangkok, the owner's timezone: there is no per-user timezone yet.
// Bangkok is UTC+7 all year round (no daylight saving), so a fixed offset is exact.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

const round2 = (value) => Math.round(value * 100) / 100;

const parseDate = (value) => {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The caller's costs with `date` in [from, to), each with its category, fund and amountInUserCurrency.
 * The same joins as GET /costs: a cost whose category is gone is left out there, so it is here too.
 */
const loadCosts = (user, from, to) => Cost.aggregate([
    { $match: { user: user.id, date: { $gte: from, $lt: to } } },
    { $lookup: { from: 'categories', localField: 'category', foreignField: '_id', as: 'category' } },
    { $unwind: '$category' },
    { $lookup: { from: 'funds', localField: 'fund', foreignField: '_id', as: 'fund' } },
    { $unwind: { path: '$fund', preserveNullAndEmptyArrays: true } },
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
            fund: { _id: 1, name: 1, currency: 1 }
        }
    }
]);

// Totals and counts per key, in first-seen order; `describe` gives the fields of a new entry
const groupBy = (costs, keyOf, describe) => {
    const groups = new Map();

    for (const cost of costs) {
        const key = keyOf(cost);

        if (!groups.has(key)) {
            groups.set(key, { ...describe(cost), total: 0, count: 0 });
        }

        const group = groups.get(key);

        group.total += cost.amountInUserCurrency;
        group.count += 1;
    }

    return groups;
};

const sumOf = (costs) => costs.reduce((total, cost) => total + cost.amountInUserCurrency, 0);

const byTotalDesc = (a, b) => b.total - a.total;

const describeCategory = (cost) => ({
    id: cost.category._id.toString(),
    name: cost.category.name,
    icon: cost.category.icon
});

/**
 * The period [dateFrom, dateTo) as GET /costs reads it, compared with the same number of days
 * immediately before dateFrom. All amounts are in the user's default currency.
 */
router.get('/analytics/summary', authenticate, async (req, res) => {
    try {
        const dateFrom = parseDate(req.query.dateFrom);
        const dateTo = parseDate(req.query.dateTo);

        if (!dateFrom || !dateTo) {
            return res.status(400).json({ error: 'dateFrom and dateTo must be valid dates' });
        }

        if (dateTo <= dateFrom) {
            return res.status(400).json({ error: 'dateTo must be after dateFrom' });
        }

        // The web sends the last millisecond of the period as dateTo, so a month is 31 days, not 30.99
        const days = Math.ceil((dateTo - dateFrom) / DAY_MS);

        if (days > MAX_RANGE_DAYS) {
            return res.status(400).json({ error: `The period must not be longer than ${MAX_RANGE_DAYS} days` });
        }

        const previousFrom = new Date(dateFrom.getTime() - days * DAY_MS);
        const costs = await loadCosts(req.user, previousFrom, dateTo);
        const current = costs.filter(cost => cost.date >= dateFrom);
        const previous = costs.filter(cost => cost.date < dateFrom);

        const total = sumOf(current);
        const previousTotal = sumOf(previous);

        // Only while the period is under way: the pace so far, carried to its end
        const now = Date.now();
        let projection = null;

        if (now >= dateFrom.getTime() && now < dateTo.getTime()) {
            const elapsedDays = Math.max(1, Math.ceil((now - dateFrom) / DAY_MS));

            projection = round2(total / elapsedDays * days);
        }

        // A category spent on in only one of the periods shows with 0 on the other side
        const categories = groupBy(current, cost => cost.category._id.toString(), describeCategory);
        const previousCategories = groupBy(previous, cost => cost.category._id.toString(), describeCategory);

        for (const [id, category] of previousCategories) {
            if (!categories.has(id)) {
                categories.set(id, { id: category.id, name: category.name, icon: category.icon, total: 0, count: 0 });
            }
        }

        const categoryList = [...categories.values()]
            .map(category => ({
                ...category,
                share: total > 0 ? Math.round(category.total / total * 10000) / 10000 : 0,
                previousTotal: previousCategories.get(category.id)?.total ?? 0
            }))
            .sort((a, b) => byTotalDesc(a, b) || b.previousTotal - a.previousTotal);

        const funds = [...groupBy(
            current,
            cost => cost.fund ? cost.fund._id.toString() : null,
            cost => cost.fund
                ? { id: cost.fund._id.toString(), name: cost.fund.name, currency: cost.fund.currency }
                : { id: null, name: NO_FUND_NAME, currency: null }
        ).values()].sort(byTotalDesc);

        const tagged = current.flatMap(cost => cost.tags.map(tag => ({ tag, amountInUserCurrency: cost.amountInUserCurrency })));
        const tags = [...groupBy(tagged, item => item.tag, item => ({ tag: item.tag })).values()].sort(byTotalDesc);

        const top = [...current]
            .sort((a, b) => b.amountInUserCurrency - a.amountInUserCurrency || b.date - a.date)
            .slice(0, TOP_SIZE)
            .map(cost => ({
                id: cost._id.toString(),
                date: cost.date,
                category: describeCategory(cost),
                comment: cost.comment ?? null,
                amount: cost.amount,
                currency: cost.currency,
                amountInUserCurrency: cost.amountInUserCurrency,
                fund: cost.fund ? { id: cost.fund._id.toString(), name: cost.fund.name } : null,
                tags: cost.tags
            }));

        res.status(200).json({
            currency: req.user.defaultCurrency || 'USD',
            period: { dateFrom, dateTo, days },
            total,
            count: current.length,
            avgPerDay: round2(total / days),
            projection,
            previous: { dateFrom: previousFrom, dateTo: dateFrom, total: previousTotal, count: previous.length },
            categories: categoryList,
            funds,
            tags,
            top
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to build the summary' });
    }
});

// 'YYYY-MM' of the Bangkok calendar month a moment falls in
const bangkokMonthKey = (date) => new Date(date.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 7);

// The instant a Bangkok calendar month starts; month may be out of 0-11, as with Date.UTC
const bangkokMonthStart = (year, month) => new Date(Date.UTC(year, month, 1) - BANGKOK_OFFSET_MS);

/**
 * Totals per Bangkok calendar month for the last `months` months, the current one included, oldest first.
 * A month without expenses is present with total 0.
 */
router.get('/analytics/monthly', authenticate, async (req, res) => {
    try {
        const rawMonths = req.query.months ?? '12';
        const months = typeof rawMonths === 'string' && /^\d+$/.test(rawMonths) ? Number(rawMonths) : NaN;

        if (!(months >= 1 && months <= 24)) {
            return res.status(400).json({ error: 'months must be a whole number from 1 to 24' });
        }

        const nowInBangkok = new Date(Date.now() + BANGKOK_OFFSET_MS);
        const year = nowInBangkok.getUTCFullYear();
        const month = nowInBangkok.getUTCMonth();

        const result = new Map();

        for (let offset = months - 1; offset >= 0; offset -= 1) {
            const key = bangkokMonthKey(bangkokMonthStart(year, month - offset));

            result.set(key, { month: key, total: 0, categories: new Map() });
        }

        const costs = await loadCosts(req.user, bangkokMonthStart(year, month - months + 1), bangkokMonthStart(year, month + 1));

        for (const cost of costs) {
            const entry = result.get(bangkokMonthKey(cost.date));
            const categoryId = cost.category._id.toString();

            if (!entry.categories.has(categoryId)) {
                entry.categories.set(categoryId, { ...describeCategory(cost), total: 0 });
            }

            entry.total += cost.amountInUserCurrency;
            entry.categories.get(categoryId).total += cost.amountInUserCurrency;
        }

        res.status(200).json({
            currency: req.user.defaultCurrency || 'USD',
            months: [...result.values()].map(entry => ({
                ...entry,
                categories: [...entry.categories.values()].sort(byTotalDesc)
            }))
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to build the monthly totals' });
    }
});

module.exports = router;
