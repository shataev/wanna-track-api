const Budget = require('../models/Budget');
const Category = require('../models/Category');
const { parseObjectId } = require('../utils/id.utils');
const { isCategoryUsable } = require('../utils/category.utils');
const { parseAmount } = require('./costService');
const { BANGKOK_OFFSET_MS, bangkokMonthKey, bangkokMonthStart, loadCosts } = require('./analyticsService');

// A day is "ahead of pace" when the share of the limit used is more than this many points over the share of the month gone
const PACE_MARGIN = 10;
// ...or when this share of the limit is used, whatever the pace
const AHEAD_PERCENT = 80;

const round2 = (value) => Math.round(value * 100) / 100;

const userCurrencyOf = (user) => user.defaultCurrency || 'USD';

/**
 * { year, month (0-11) } of a 'YYYY-MM' string, or null for anything else.
 * Month boundaries, elapsed days and pace are all counted in Asia/Bangkok, as in analytics.
 */
const parseMonth = (value) => {
    const match = typeof value === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);

    return match ? { year: Number(match[1]), month: Number(match[2]) - 1 } : null;
};

/**
 * The calendar facts of a Bangkok month: its instants, length, and how much of it has elapsed now
 * (today counted; all of a past month, none of a future one).
 */
const describeMonth = ({ year, month }) => {
    const from = bangkokMonthStart(year, month);
    const to = bangkokMonthStart(year, month + 1);
    const daysInMonth = Math.round((to - from) / (24 * 60 * 60 * 1000));
    const now = Date.now();

    let elapsedDays;

    if (now >= to.getTime()) {
        elapsedDays = daysInMonth;
    } else if (now < from.getTime()) {
        elapsedDays = 0;
    } else {
        elapsedDays = new Date(now + BANGKOK_OFFSET_MS).getUTCDate();
    }

    return {
        key: bangkokMonthKey(from),
        from,
        to,
        daysInMonth,
        elapsedDays,
        pacePercent: round2(elapsedDays / daysInMonth * 100)
    };
};

// on_track / ahead / over, from the unrounded figures
const stateOf = (spent, limit, pacePercent) => {
    if (spent > limit) {
        return 'over';
    }

    const percent = spent / limit * 100;

    return percent > pacePercent + PACE_MARGIN || percent >= AHEAD_PERCENT ? 'ahead' : 'on_track';
};

/**
 * Budget documents as response items for `month` (a describeMonth result). Spent is the total of the user's costs
 * in the category in that month, from the same aggregation analytics uses, so the two never disagree.
 * A budget whose category no longer exists is left out, as a cost in such a category is in analytics.
 * A budget in another currency than the user's default one has no figures and no state: nothing is converted.
 */
const buildItems = async (user, budgets, month) => {
    if (budgets.length === 0) {
        return [];
    }

    const currency = userCurrencyOf(user);
    const categories = new Map(
        (await Category.find({ _id: { $in: budgets.map(budget => budget.category) } }))
            .map(category => [String(category._id), category])
    );
    const spentBy = new Map();

    for (const cost of await loadCosts(user, month.from, month.to)) {
        const id = String(cost.category._id);

        spentBy.set(id, (spentBy.get(id) ?? 0) + cost.amountInUserCurrency);
    }

    return budgets
        .filter(budget => categories.has(String(budget.category)))
        .map((budget) => {
            const category = categories.get(String(budget.category));
            const item = {
                id: String(budget._id),
                category: { id: String(category._id), name: category.name, icon: category.icon },
                limit: budget.amount,
                currency: budget.currency
            };

            if (budget.currency !== currency) {
                return { ...item, spent: null, remaining: null, percent: null, state: null, currencyMismatch: true };
            }

            const spent = spentBy.get(String(category._id)) ?? 0;

            return {
                ...item,
                spent,
                remaining: budget.amount - spent,
                percent: round2(spent / budget.amount * 100),
                state: stateOf(spent, budget.amount, month.pacePercent),
                currencyMismatch: false
            };
        })
        // Most used first; the ones without figures last
        .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
};

const currentMonth = () => parseMonth(bangkokMonthKey(new Date(Date.now())));

/**
 * The caller's budgets with their spending in a Bangkok month (default: the current one).
 * Resolves to { body } or to { status, error }; `query.month` is 'YYYY-MM'.
 */
const listBudgets = async (user, query = {}) => {
    const parsed = query.month === undefined ? currentMonth() : parseMonth(query.month);

    if (!parsed) {
        return { status: 400, error: 'month must be YYYY-MM' };
    }

    const month = describeMonth(parsed);
    const budgets = await Budget.find({ user: user.id });

    return {
        body: {
            currency: userCurrencyOf(user),
            month: month.key,
            dateFrom: month.from,
            dateTo: month.to,
            daysInMonth: month.daysInMonth,
            elapsedDays: month.elapsedDays,
            pacePercent: month.pacePercent,
            budgets: await buildItems(user, budgets, month)
        }
    };
};

/**
 * Create or replace the limit of a category, in the user's default currency; resolves to { body: item } for
 * the current month, or to { status, error }. `categoryId` and `amount` are raw request values.
 */
const setBudget = async (user, categoryId, amount) => {
    const limit = parseAmount(amount);

    if (limit === null) {
        return { status: 400, error: 'Amount must be a positive number' };
    }

    const category = parseObjectId(categoryId);

    // The same rule as for a cost: a global category or the caller's own
    if (!await isCategoryUsable(user.id, category)) {
        return { status: 404, error: 'Category not found' };
    }

    const write = () => Budget.findOneAndUpdate(
        { user: user.id, category },
        { $set: { amount: limit, currency: userCurrencyOf(user) } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    let budget;

    try {
        budget = await write();
    } catch (error) {
        // Two first writes at once: the other one created it, this one replaces it
        if (error.code !== 11000) {
            throw error;
        }

        budget = await write();
    }

    const [item] = await buildItems(user, [budget], describeMonth(currentMonth()));

    return { body: item };
};

// Remove the limit of a category; resolves to {} or to { status, error } (404 when there was none)
const removeBudget = async (user, categoryId) => {
    const category = parseObjectId(categoryId);
    const removed = category && await Budget.findOneAndDelete({ user: user.id, category });

    return removed ? {} : { status: 404, error: 'Budget not found' };
};

/**
 * The budget line for a saved cost: the item of its category for the month of its date plus `month`,
 * or null without a limit. Never throws: the cost is already saved, and failing the request would make
 * the user book it twice.
 */
const budgetForCost = async (user, cost) => {
    try {
        const budget = await Budget.findOne({ user: user.id, category: cost.category });

        if (!budget) {
            return null;
        }

        const month = describeMonth(parseMonth(bangkokMonthKey(cost.date)));
        const [item] = await buildItems(user, [budget], month);

        return item ? { ...item, month: month.key } : null;
    } catch (error) {
        console.error('[budgets] lookup after a new cost failed', error);

        return null;
    }
};

module.exports = { listBudgets, setBudget, removeBudget, budgetForCost };
