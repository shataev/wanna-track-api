const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const z = require('zod');
const Category = require('../models/Category');
const Fund = require('../models/Fund');
const { createCost, listCosts, listTags } = require('./costService');
const { buildSummary, buildMonthly, BANGKOK_OFFSET_MS } = require('./analyticsService');
const { listBudgets, setBudget, removeBudget, budgetForCost } = require('./budgetService');
const { setActiveTag } = require('./userService');
const { createFund, updateFund, deleteFund, setFundArchived, transferFunds } = require('./fundService');
const { calculateTotalFundsAmount, goalProgress } = require('../utils/fund.utils');
const { normalizeTag } = require('../utils/tag.utils');
const { SCOPE_WRITE } = require('../utils/oauth.config');

/**
 * The MCP server for one request, acting as `user` (the shape of req.user) with the token's scopes.
 * Every tool goes through the services the REST routes use, so prices, conversions and totals are the same
 * as on the web. Write tools exist only with expenses.write: a read-only token does not even list them.
 */

const TIMEZONE_NOTE = 'Dates are stored as instants. Calendar days and months are counted in Asia/Bangkok (UTC+7, no daylight saving).';

const DATE_DESCRIPTION = 'ISO 8601. A bare date such as 2026-10-01 means midnight in Bangkok (UTC+7) that day.';

const INSTRUCTIONS = `Wanna Track is the user's personal expense tracker.
Every amount comes with its currency. "amountInUserCurrency" is converted to the user's default currency at the rate saved with the expense.
${TIMEZONE_NOTE}
Funds are the user's accounts (cash, cards) and savings; an expense paid from a fund is debited from its balance, converted to the fund's currency.
A fund has a kind: "account" (money to spend from) or "savings" (a separate real balance, such as a savings account for a trip). A savings fund may have a goal (amount in the fund's currency, optional date) with goalProgress (percent, remaining, monthsLeft, perMonth, reached). Spending from a savings fund is allowed; the total splits into available (accounts) and saved (savings).
A fund the user no longer uses is archived: it is not listed by default (list_funds includeArchived shows it), is not in the total, and takes no new expenses, but its past expenses keep its name.
Funds can be created, edited, archived, restored and moved between (transfer_funds) with the write tools; delete_fund only removes a fund with no history (no expenses, transfers or balance corrections) — anything else is archived instead.
Categories can have a monthly limit (budget) in the default currency: it never blocks an expense, going over is only shown. get_budgets shows spent, remaining and state (on_track, ahead of pace, over) per limit; set_budget sets or removes one.
Call get_profile first to learn the default currency, the active tag and today's date.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const toolError = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

const isDateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

// An ISO string the REST routes would accept: a bare date becomes Bangkok midnight
const toInstantString = (value) => isDateOnly(value) ? `${value}T00:00:00+07:00` : value;

const parseInstant = (value) => {
    const date = new Date(toInstantString(value));

    return Number.isNaN(date.getTime()) ? null : date;
};

const bangkokToday = () => new Date(Date.now() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);

const userCurrencyOf = (user) => user.defaultCurrency || 'USD';

const describeCategory = (category) => ({
    id: String(category._id),
    name: category.name,
    icon: category.icon,
    global: !category.user
});

const describeFund = (fund) => ({
    id: String(fund._id),
    name: fund.name,
    currency: fund.currency,
    balance: fund.currentBalance,
    isDefault: Boolean(fund.isDefault),
    description: fund.description || null,
    kind: fund.kind || 'account',
    goal: fund.goal ? { amount: fund.goal.amount, date: fund.goal.date } : null,
    ...(fund.goal ? { goalProgress: goalProgress(fund) } : {}),
    ...(fund.archivedAt ? { archived: true } : {})
});

const describeCost = (cost) => ({
    id: String(cost._id),
    date: cost.date,
    amount: cost.amount,
    currency: cost.currency,
    amountInUserCurrency: cost.amountInUserCurrency,
    category: { id: String(cost.category._id), name: cost.category.name },
    fund: cost.fund ? { id: String(cost.fund._id), name: cost.fund.name, currency: cost.fund.currency } : null,
    fundAmount: cost.fundAmount,
    tags: cost.tags,
    comment: cost.comment ?? null
});

const findCategories = (user) => Category.find({ user: { $in: [null, user.id] } }).sort({ name: 1 });

// Active funds only, unless the caller names archived ones too (history keeps pointing at them)
const findFunds = (user, { includeArchived = false } = {}) =>
    Fund.find({ userId: user.id, ...(includeArchived ? {} : { archivedAt: null }) }).sort({ name: 1 });

/**
 * One of `items` by id or by name (case-insensitive, exact). Never a guess: no match or several matches
 * resolve to { error } listing what there is.
 */
const resolveByNameOrId = (items, value, kind) => {
    const byId = items.find(item => String(item._id) === value);

    if (byId) {
        return { item: byId };
    }

    const wanted = value.trim().toLowerCase();
    const matches = items.filter(item => item.name.trim().toLowerCase() === wanted);

    if (matches.length === 1) {
        return { item: matches[0] };
    }

    const available = items.map(item => `${item.name} (id ${item._id})`).join(', ') || 'none';

    if (matches.length > 1) {
        return { error: `Several ${kind} are called "${value}". Pass one of their ids: ${available}` };
    }

    return { error: `Unknown ${kind.replace(/ies$/, 'y').replace(/s$/, '')} "${value}". Available ${kind}: ${available}` };
};

// "1500 JPY → 360 THB · Cash · #japan-2026", like the bot's confirmation
const summarizeCost = (cost, userCurrency) => {
    let line = `${cost.amount} ${cost.currency}`;

    if (cost.fund) {
        if (cost.fund.currency !== cost.currency) {
            line += ` → ${cost.fundAmount} ${cost.fund.currency}`;
        }

        line += ` · ${cost.fund.name}`;
    } else if (cost.currency !== userCurrency) {
        line += ` → ${cost.amountInUserCurrency} ${userCurrency}`;
    }

    if (cost.tags.length > 0) {
        line += ` · ${cost.tags.map(tag => `#${tag}`).join(' ')}`;
    }

    return line;
};

// "Food: 2140 / 3000 THB · left 860", or "· over by 340"; empty when the budget has no figures
const summarizeBudget = (budget) => {
    if (budget.currencyMismatch) {
        return '';
    }

    const used = `${budget.category.name}: ${budget.spent} / ${budget.limit} ${budget.currency}`;

    return budget.remaining < 0
        ? `${used} · over by ${-budget.remaining}`
        : `${used} · left ${budget.remaining}`;
};

const registerReadTools = (server, user) => {
    const readOnly = { readOnlyHint: true, openWorldHint: false };

    server.registerTool('get_profile', {
        title: 'Profile',
        description: 'The user\'s default currency (every summary is in it), the active tag that new expenses get automatically, the timezone used for days and months, and today\'s date in that timezone.',
        annotations: readOnly
    }, async () => json({
        username: user.username,
        defaultCurrency: userCurrencyOf(user),
        activeTag: user.activeTag ?? null,
        timezone: 'Asia/Bangkok',
        timezoneNote: TIMEZONE_NOTE,
        today: bangkokToday(),
        now: new Date().toISOString()
    }));

    server.registerTool('list_categories', {
        title: 'Categories',
        description: 'The expense categories the user can use: shared ones (global: true) and their own. Use a name or id from here for add_expense and list_expenses.',
        annotations: readOnly
    }, async () => json({ categories: (await findCategories(user)).map(describeCategory) }));

    server.registerTool('list_funds', {
        title: 'Funds',
        description: 'The user\'s active funds (accounts such as cash or a card, and savings), each with its kind, current balance in its own currency and, for savings with a goal, the goal and its progress, and the total of their balances in the user\'s default currency, split into available (accounts) and saved (savings). Archived funds (accounts the user no longer uses) are left out and do not count in the total; includeArchived adds them, marked archived: true.',
        inputSchema: {
            includeArchived: z.boolean().optional().describe('Also list archived funds, marked archived: true. Default false')
        },
        annotations: readOnly
    }, async ({ includeArchived = false } = {}) => {
        const funds = await findFunds(user, { includeArchived });
        const total = await calculateTotalFundsAmount(user.id, userCurrencyOf(user));

        return json({
            currency: userCurrencyOf(user),
            funds: funds.map(describeFund),
            total: total ? { amount: total.total, available: total.available, saved: total.saved, currency: total.baseCurrency } : null
        });
    });

    server.registerTool('list_tags', {
        title: 'Tags',
        description: 'The tags used on the user\'s expenses (such as a trip), most recently used first, with how many expenses carry each and their total in the user\'s default currency.',
        annotations: readOnly
    }, async () => json({ currency: userCurrencyOf(user), tags: await listTags(user) }));

    server.registerTool('list_expenses', {
        title: 'Expenses',
        description: 'The user\'s expenses, newest first, optionally filtered. Each has the amount in the currency it was paid in, the amount in the user\'s default currency, the fund it was paid from (and what that fund was debited in its own currency), category, tags, comment, date and id. For totals and comparisons prefer get_summary.',
        inputSchema: {
            dateFrom: z.string().optional().describe(`Earliest date, inclusive. ${DATE_DESCRIPTION}`),
            dateTo: z.string().optional().describe(`End of the period, exclusive: 2026-11-01 ends October. ${DATE_DESCRIPTION}`),
            category: z.string().optional().describe('Category name (case-insensitive) or id'),
            tag: z.string().optional().describe('Only expenses with this tag'),
            fund: z.string().optional().describe('Fund name (case-insensitive) or id'),
            limit: z.number().int().min(1).max(500).optional().describe('At most this many expenses, default 100, max 500')
        },
        annotations: readOnly
    }, async ({ dateFrom, dateTo, category, tag, fund, limit = 100 }) => {
        const filters = { limit: limit + 1 };

        for (const [name, value] of [['from', dateFrom], ['to', dateTo]]) {
            if (value !== undefined) {
                const date = parseInstant(value);

                if (!date) {
                    return toolError(`${name === 'from' ? 'dateFrom' : 'dateTo'} is not a valid date: ${value}`);
                }

                filters[name] = date;
            }
        }

        if (category !== undefined) {
            const found = resolveByNameOrId(await findCategories(user), category, 'categories');

            if (found.error) {
                return toolError(found.error);
            }

            filters.categoryId = found.item._id;
        }

        if (fund !== undefined) {
            const found = resolveByNameOrId(await findFunds(user, { includeArchived: true }), fund, 'funds');

            if (found.error) {
                return toolError(found.error);
            }

            filters.fundId = found.item._id;
        }

        if (tag !== undefined) {
            filters.tag = normalizeTag(tag);

            // No expense can carry a tag that normalises to nothing
            if (!filters.tag) {
                return json({ currency: userCurrencyOf(user), count: 0, truncated: false, expenses: [] });
            }
        }

        const costs = await listCosts(user, filters);
        const truncated = costs.length > limit;
        const expenses = costs.slice(0, limit).map(describeCost);

        return json({ currency: userCurrencyOf(user), count: expenses.length, truncated, expenses });
    });

    server.registerTool('get_summary', {
        title: 'Spending summary',
        description: 'Spending in a period [dateFrom, dateTo), at most 400 days, all in the user\'s default currency: total, count, average per day, a projection to the end of the period while it is under way, totals by category, fund and tag, the top 10 expenses, and a comparison with the previous period (the previous calendar month when the period is one Bangkok calendar month, otherwise the same number of days before). The same numbers as the Analytics page of the web app.',
        inputSchema: {
            dateFrom: z.string().describe(`Start, inclusive. ${DATE_DESCRIPTION}`),
            dateTo: z.string().describe(`End, exclusive: 2026-11-01 ends October. ${DATE_DESCRIPTION}`)
        },
        annotations: readOnly
    }, async ({ dateFrom, dateTo }) => {
        const result = await buildSummary(user, { dateFrom: toInstantString(dateFrom), dateTo: toInstantString(dateTo) });

        return result.error ? toolError(result.error) : json(result.body);
    });

    server.registerTool('get_budgets', {
        title: 'Budgets',
        description: 'The user\'s monthly category limits with what is spent against them in a Bangkok calendar month (default: the current one), in the user\'s default currency: limit, spent, remaining (negative when over), percent used, and state: on_track, ahead (spending faster than the month passes, or 80%+ used) or over. Also how far through the month we are (pacePercent). A limit never blocks an expense. A budget with currencyMismatch: true was set in another currency than the default one and has no figures until it is set again.',
        inputSchema: {
            month: z.string().optional().describe('YYYY-MM, default: the current month')
        },
        annotations: readOnly
    }, async ({ month }) => {
        const result = await listBudgets(user, { month });

        return result.error ? toolError(result.error) : json(result.body);
    });

    server.registerTool('get_monthly_trend', {
        title: 'Monthly trend',
        description: 'Totals per Bangkok calendar month for the last `months` months, the current month included, oldest first, each split by category; in the user\'s default currency. A month without expenses has total 0.',
        inputSchema: {
            months: z.number().int().min(1).max(24).optional().describe('How many months, 1 to 24, default 12')
        },
        annotations: readOnly
    }, async ({ months }) => {
        const result = await buildMonthly(user, { months: months === undefined ? undefined : String(months) });

        return result.error ? toolError(result.error) : json(result.body);
    });
};


const fundInput = {
    icon: z.string().trim().min(1).max(100).optional().describe('Material Design Icons name such as "cash" or "mdi-piggy-bank", as on materialdesignicons.com'),
    description: z.string().max(1000).optional().describe('A note about the fund'),
    kind: z.enum(['account', 'savings']).optional().describe('"account": money to spend from (cash, a card). "savings": a separate real balance put aside, such as a savings account for a trip'),
    goal: z.object({
        amount: z.number().positive().describe('Target balance in the fund\'s currency'),
        date: z.string().optional().describe(`Target date, optional. ${DATE_DESCRIPTION}`)
    }).nullable().optional().describe('Savings funds only: a target amount and optional date; null removes the goal'),
    isDefault: z.boolean().optional().describe('Preselected for new expenses on the web. Not allowed for a savings or archived fund')
};

const toIcon = (icon) => icon === undefined ? undefined : (icon.startsWith('mdi-') ? icon : `mdi-${icon}`);

// The goal as the service reads it, with a bare date at Bangkok midnight; { error } for a bad date
const toGoal = (goal) => {
    if (goal === undefined || goal === null || goal.date === undefined) {
        return { goal };
    }

    const date = parseInstant(goal.date);

    return date ? { goal: { amount: goal.amount, date: date.toISOString() } } : { error: `goal.date is not a valid date: ${goal.date}` };
};

// "Cash: 5000 THB", plus the kind and state when they are not the usual ones
const summarizeFund = (fund) => {
    let line = `${fund.name}: ${fund.balance} ${fund.currency}`;

    if (fund.kind === 'savings') {
        line += ' · savings';

        if (fund.goal) {
            line += ` · goal ${fund.goal.amount} ${fund.currency}`;
        }
    }

    if (fund.archived) {
        line += ' · archived';
    }

    return line;
};

const fundResult = (fund, extra = {}) => {
    const described = describeFund(fund);

    return json({ summary: summarizeFund(described), ...extra, fund: described });
};

const registerFundTools = (server, user) => {
    // Archived funds too: they can still be renamed, restored or deleted
    const resolveFund = async (value) => resolveByNameOrId(await findFunds(user, { includeArchived: true }), value, 'funds');

    server.registerTool('create_fund', {
        title: 'Create a fund',
        description: 'Create a fund: an account the user spends from (cash, a card, a bank account) or a savings fund (a separate balance put aside, optionally with a goal). The starting balance is what is on it now, in its currency. Returns the new fund.',
        inputSchema: {
            name: z.string().trim().min(1).max(200).describe('Name shown everywhere, e.g. "Cash" or "Japan trip"'),
            currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Three-letter code of the money on it, such as THB. Default: the user\'s default currency'),
            initialBalance: z.number().min(0).optional().describe('What is on it now, in its currency. Default 0'),
            ...fundInput
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ name, currency, initialBalance = 0, icon, description, kind, goal, isDefault }) => {
        const parsedGoal = toGoal(goal);

        if (parsedGoal.error) {
            return toolError(parsedGoal.error);
        }

        const result = await createFund(user, {
            name,
            currency: (currency ?? userCurrencyOf(user)).toUpperCase(),
            initialBalance,
            icon: toIcon(icon),
            description,
            kind,
            goal: parsedGoal.goal ?? undefined,
            isDefault
        });

        return result.error ? toolError(result.error) : fundResult(result.fund);
    });

    server.registerTool('update_fund', {
        title: 'Edit a fund',
        description: 'Change a fund: name, icon, description, kind, savings goal, default flag, or its balance. Setting balance overwrites the current balance and is recorded as a manual correction in the fund\'s history — use it only to match the real account, not to move money (that is transfer_funds) or to record spending (that is add_expense). Only the fields given change. The currency cannot be changed. Returns the fund.',
        inputSchema: {
            fund: z.string().describe('Fund name (case-insensitive) or id, see list_funds; archived funds too'),
            name: z.string().trim().min(1).max(200).optional().describe('New name'),
            balance: z.number().optional().describe('The real current balance, in the fund\'s currency'),
            ...fundInput
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async ({ fund, name, balance, icon, description, kind, goal, isDefault }) => {
        const found = await resolveFund(fund);

        if (found.error) {
            return toolError(found.error);
        }

        const parsedGoal = toGoal(goal);

        if (parsedGoal.error) {
            return toolError(parsedGoal.error);
        }

        // A field not given stays undefined, and Mongoose leaves it out of the update
        const result = await updateFund(user, found.item._id, {
            name,
            currentBalance: balance,
            icon: toIcon(icon),
            description,
            kind,
            goal: parsedGoal.goal,
            isDefault
        });

        if (result.error) {
            return toolError(result.error);
        }

        const change = result.fund.currentBalance - result.previousBalance;

        return fundResult(result.fund, change !== 0 ? { balanceChange: { from: result.previousBalance, to: result.fund.currentBalance, currency: result.fund.currency } } : {});
    });

    server.registerTool('archive_fund', {
        title: 'Archive a fund',
        description: 'Archive a fund the user no longer uses: it disappears from the fund lists and the total, and takes no new expenses or transfers, but its balance and history are kept and its past expenses still name it. Any balance is allowed. restore_fund brings it back. Archiving the default fund clears that flag.',
        inputSchema: {
            fund: z.string().describe('Fund name (case-insensitive) or id, see list_funds')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ fund }) => {
        const found = await resolveFund(fund);

        if (found.error) {
            return toolError(found.error);
        }

        const result = await setFundArchived(user, found.item._id, true);

        return result.error ? toolError(result.error) : fundResult(result.fund);
    });

    server.registerTool('restore_fund', {
        title: 'Restore an archived fund',
        description: 'Bring an archived fund back: it is listed and counted in the total again and can take expenses and transfers.',
        inputSchema: {
            fund: z.string().describe('Fund name (case-insensitive) or id, see list_funds with includeArchived')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ fund }) => {
        const found = await resolveFund(fund);

        if (found.error) {
            return toolError(found.error);
        }

        const result = await setFundArchived(user, found.item._id, false);

        return result.error ? toolError(result.error) : fundResult(result.fund);
    });

    server.registerTool('delete_fund', {
        title: 'Delete a fund',
        description: 'Delete a fund for good. Only a fund with no history can be deleted: no expense paid from it, no transfer and no balance correction (for example one created by mistake). A fund with history is refused — offer archive_fund instead. Confirm with the user before deleting.',
        inputSchema: {
            fund: z.string().describe('Fund name (case-insensitive) or id, see list_funds')
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, async ({ fund }) => {
        const found = await resolveFund(fund);

        if (found.error) {
            return toolError(found.error);
        }

        const result = await deleteFund(user, found.item._id);

        if (result.code === 'fund_has_history') {
            return toolError(`"${found.item.name}" has history (expenses, transfers or balance corrections), so it cannot be deleted; archive_fund keeps the history and hides it.`);
        }

        return result.error ? toolError(result.error) : json({ deleted: { id: String(result.fund._id), name: result.fund.name } });
    });

    server.registerTool('transfer_funds', {
        title: 'Move money between funds',
        description: 'Move money from one of the user\'s funds to another, e.g. putting money aside into a savings fund or withdrawing cash from a card. The amount is in the source fund\'s currency; between currencies it is converted at today\'s rate and the credited amount is returned. The source must hold enough; archived funds cannot take part.',
        inputSchema: {
            from: z.string().describe('Source fund name (case-insensitive) or id'),
            to: z.string().describe('Destination fund name (case-insensitive) or id'),
            amount: z.number().positive().describe('How much leaves the source fund, in its currency'),
            comment: z.string().max(1000).optional().describe('What the transfer is for')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ from, to, amount, comment }) => {
        const funds = await findFunds(user, { includeArchived: true });
        const source = resolveByNameOrId(funds, from, 'funds');

        if (source.error) {
            return toolError(source.error);
        }

        const target = resolveByNameOrId(funds, to, 'funds');

        if (target.error) {
            return toolError(target.error);
        }

        const result = await transferFunds(user, {
            fromFundId: String(source.item._id),
            toFundId: String(target.item._id),
            amount,
            description: comment
        });

        if (result.error) {
            return toolError(result.error);
        }

        const { withdrawn, credited, rate } = result.body;
        const [fromFund, toFund] = await Promise.all([Fund.findById(source.item._id), Fund.findById(target.item._id)]);
        let summary = `${withdrawn.amount} ${withdrawn.currency}`;

        if (credited.currency !== withdrawn.currency) {
            summary += ` → ${credited.amount} ${credited.currency}`;
        }

        summary += ` · ${fromFund.name} → ${toFund.name}`;

        return json({ summary, withdrawn, credited, rate, from: describeFund(fromFund), to: describeFund(toFund) });
    });
};

const registerWriteTools = (server, user) => {
    server.registerTool('add_expense', {
        title: 'Add an expense',
        description: 'Record an expense, the same way the web app and the Telegram bot do. With a fund, the fund is debited, converted to its currency at today\'s rate; without one, nothing is debited. Without tags, the active tag (see get_profile) is applied; pass tags: [] for none. Category and fund are matched by id or exact name (case-insensitive); an unknown name is an error that lists the available ones, so ask the user rather than guessing. Returns the saved expense and a one-line confirmation.',
        inputSchema: {
            amount: z.number().positive().describe('What was paid, in `currency`'),
            currency: z.string().optional().describe('Three-letter code such as JPY. Default: the fund\'s currency, else the user\'s default currency'),
            category: z.string().describe('Category name or id, see list_categories'),
            fund: z.string().optional().describe('Fund name or id the money came from, see list_funds'),
            date: z.string().optional().describe(`When it was paid; default now. ${DATE_DESCRIPTION}`),
            comment: z.string().optional().describe('What it was, e.g. "Ramen"'),
            tags: z.array(z.string()).optional().describe('Tags such as a trip; default: the active tag')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ amount, currency, category, fund, date, comment, tags }) => {
        const foundCategory = resolveByNameOrId(await findCategories(user), category, 'categories');

        if (foundCategory.error) {
            return toolError(foundCategory.error);
        }

        let fundId;

        if (fund !== undefined) {
            const foundFund = resolveByNameOrId(await findFunds(user), fund, 'funds');

            if (foundFund.error) {
                return toolError(foundFund.error);
            }

            fundId = foundFund.item._id;
        }

        let paidAt = new Date();

        if (date !== undefined) {
            paidAt = parseInstant(date);

            if (!paidAt) {
                return toolError(`date is not a valid date: ${date}`);
            }
        }

        const result = await createCost(user, {
            amount,
            currency,
            category: foundCategory.item._id,
            fundId,
            date: paidAt,
            comment,
            tags
        });

        if (result.error) {
            return toolError(result.error);
        }

        // Read back through the same aggregation as every list, so the converted amount is the one the web shows
        const [saved] = await listCosts(user, { costId: result.cost._id });
        const expense = describeCost(saved);

        const budget = await budgetForCost(user, result.cost);

        return json({
            summary: summarizeCost(expense, userCurrencyOf(user)),
            currency: userCurrencyOf(user),
            expense,
            ...(budget ? { budget, budgetSummary: summarizeBudget(budget) } : {})
        });
    });

    server.registerTool('set_budget', {
        title: 'Set a budget',
        description: 'Set or change the monthly limit of a category, in the user\'s default currency; it applies to every month and never blocks an expense. amount 0 or null removes the limit. Returns the budget with this month\'s spending, or { removed } when removing.',
        inputSchema: {
            category: z.string().describe('Category name or id, see list_categories'),
            amount: z.number().min(0).nullable().describe('The monthly limit; 0 or null removes it')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ category, amount }) => {
        const found = resolveByNameOrId(await findCategories(user), category, 'categories');

        if (found.error) {
            return toolError(found.error);
        }

        if (!amount) {
            const removal = await removeBudget(user, found.item._id);

            // Removing what is not there is not a failure
            return removal.error && removal.status !== 404 ? toolError(removal.error) : json({ removed: !removal.error });
        }

        const result = await setBudget(user, found.item._id, amount);

        return result.error ? toolError(result.error) : json(result.body);
    });

    server.registerTool('set_active_tag', {
        title: 'Set the active tag',
        description: 'Set the tag every new expense gets automatically, e.g. "japan-2026" for a trip, or null to stop tagging. Tags are lower-cased, spaces become "-".',
        inputSchema: {
            tag: z.string().nullable().describe('The tag, or null to clear it')
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ tag }) => {
        const updated = await setActiveTag(user.id, tag);

        if (!updated) {
            return toolError('User not found');
        }

        return json({ activeTag: updated.activeTag });
    });
};

const createMcpServer = (user, scopes) => {
    const server = new McpServer({ name: 'wanna-track', version: '1.0.0' }, { instructions: INSTRUCTIONS });

    registerReadTools(server, user);

    if (scopes.includes(SCOPE_WRITE)) {
        registerWriteTools(server, user);
        registerFundTools(server, user);
    }

    return server;
};

module.exports = { createMcpServer };
