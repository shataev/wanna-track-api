const request = require('supertest');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const app = require('../app');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const User = require('../models/User');
const loginGuard = require('../utils/loginGuard');
const { seedUser, seedFund, seedCategory, bearer } = require('./helpers');
const { connect } = require('./oauth.helpers');

// 1 USD = 36.5 THB = 149.3 JPY
const RATES = [['THB', 36.5], ['JPY', 149.3], ['EUR', 0.9]];
// 1500 JPY debited from a THB fund, rounded to satang
const RAMEN_IN_THB = 366.71;

const READ_TOOLS = ['get_monthly_trend', 'get_profile', 'get_summary', 'list_categories', 'list_expenses', 'list_funds', 'list_tags'];
const WRITE_TOOLS = ['add_expense', 'set_active_tag'];

// The MCP SDK's own client over HTTP against the real app, the way Claude talks to it
let server;
let baseUrl;
const clients = [];

beforeAll(async () => {
    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
});

const mcpClient = async (accessToken) => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
    });

    await client.connect(transport);
    clients.push(client);

    return client;
};

const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });

    return { result, text: result.content[0].text, data: result.isError ? null : JSON.parse(result.content[0].text) };
};

// A tool the token may not use: the SDK answers with an error result or a protocol error, never with data
const callRefused = async (client, name, args) => {
    try {
        const result = await client.callTool({ name, arguments: args });

        return result.isError === true;
    } catch (error) {
        return true;
    }
};

let a;
let b;

beforeEach(async () => {
    loginGuard.reset();
    await ExchangeRate.create({ base: 'USD', rates: new Map(RATES) });

    a = { user: await seedUser({ defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ defaultCurrency: 'THB' }) };

    a.global = await seedCategory(null, { name: 'Transport', icon: 'mdi-bus' });
    a.food = await seedCategory(a.user, { name: 'Food' });
    a.cash = await seedFund(a.user, { name: 'Cash', currency: 'THB', initialBalance: 5000, currentBalance: 5000 });
    a.card = await seedFund(a.user, { name: 'Card', currency: 'THB', initialBalance: 100, currentBalance: 100 });

    b.food = await seedCategory(b.user, { name: 'B-secret-category' });
    b.cash = await seedFund(b.user, { name: 'B-secret-fund', currency: 'THB', initialBalance: 9999, currentBalance: 9999 });
});

// A cost created through the REST route, as the web app does
const restCost = async (party, fund, category, overrides = {}) => {
    const res = await request(app).post('/api/cost').set(bearer(party.user)).send({
        amount: 100,
        category: String(category._id),
        fundId: String(fund._id),
        date: '2026-09-10T05:00:00Z',
        comment: 'Lunch',
        tags: [],
        ...overrides
    });

    expect(res.status).toBe(201);

    return res.body;
};

const seedHistory = async () => {
    await restCost(a, a.cash, a.food, { amount: 120, comment: 'Noodles', tags: ['bangkok'] });
    await restCost(a, a.cash, a.global, { amount: 40, comment: 'Bus', date: '2026-09-12T05:00:00Z' });
    await restCost(a, a.cash, a.food, { amount: 10, currency: 'USD', comment: 'Coffee', date: '2026-08-20T05:00:00Z' });
    await restCost(b, b.cash, b.food, { amount: 777, comment: 'B-secret-comment', tags: ['b-secret-tag'] });
};

describe('protocol', () => {
    test('initialize: server info and instructions', async () => {
        const { tokens } = await connect(a.user);
        const client = await mcpClient(tokens.access_token);

        expect(client.getServerVersion()).toMatchObject({ name: 'wanna-track' });
        expect(client.getInstructions()).toContain('default currency');
    });

    test('tools/list with a read-only token: read tools only', async () => {
        const { tokens } = await connect(a.user);
        const client = await mcpClient(tokens.access_token);

        const { tools } = await client.listTools();

        expect(tools.map(tool => tool.name).sort()).toEqual(READ_TOOLS);
    });

    test('tools/list with a read and write token: read and write tools', async () => {
        const { tokens } = await connect(a.user, { allowWrite: true });
        const client = await mcpClient(tokens.access_token);

        const { tools } = await client.listTools();

        expect(tools.map(tool => tool.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
        expect(tools.every(tool => tool.description && tool.description.length > 40)).toBe(true);
    });

    test('GET /mcp with a token: 405, there is no stream to open', async () => {
        const { tokens } = await connect(a.user);
        const res = await request(app).get('/mcp').set('Authorization', `Bearer ${tokens.access_token}`);

        expect(res.status).toBe(405);
    });
});

describe('read tools', () => {
    let client;

    beforeEach(async () => {
        await User.updateOne({ _id: a.user._id }, { activeTag: 'japan-2026' });
        await seedHistory();
        client = await mcpClient((await connect(a.user)).tokens.access_token);
    });

    test('get_profile: default currency, active tag, Bangkok timezone, today', async () => {
        const { data } = await call(client, 'get_profile');

        expect(data).toMatchObject({ defaultCurrency: 'THB', activeTag: 'japan-2026', timezone: 'Asia/Bangkok' });
        expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(data.timezoneNote).toContain('UTC+7');
    });

    test('list_categories: global ones and the user\'s own', async () => {
        const { data } = await call(client, 'list_categories');

        expect(data.categories.map(category => [category.name, category.global]).sort()).toEqual([
            ['Food', false],
            ['Transport', true]
        ]);
    });

    test('list_funds: balances in each fund\'s currency and the total in the default currency', async () => {
        const { data } = await call(client, 'list_funds');

        expect(data.currency).toBe('THB');
        expect(data.funds.map(fund => [fund.name, fund.currency, fund.balance]).sort()).toEqual([
            ['Card', 'THB', 100],
            ['Cash', 'THB', 5000 - 120 - 40 - 365]
        ]);
        expect(data.total).toEqual({ amount: 100 + 5000 - 120 - 40 - 365, currency: 'THB' });
    });

    test('list_tags: as GET /api/tags', async () => {
        const { data } = await call(client, 'list_tags');
        const rest = await request(app).get('/api/tags').set(bearer(a.user));

        expect(data.currency).toBe('THB');
        expect(JSON.parse(JSON.stringify(data.tags))).toEqual(rest.body);
        expect(data.tags.map(tag => tag.tag)).toEqual(['bangkok']);
    });

    test('list_expenses: newest first, with currencies, converted amounts, fund, category and tags', async () => {
        const { data } = await call(client, 'list_expenses');

        expect(data.currency).toBe('THB');
        expect(data.count).toBe(3);
        expect(data.truncated).toBe(false);
        expect(data.expenses.map(cost => cost.comment)).toEqual(['Bus', 'Noodles', 'Coffee']);

        const coffee = data.expenses[2];

        expect(coffee).toMatchObject({
            amount: 10,
            currency: 'USD',
            amountInUserCurrency: 365,
            fund: { name: 'Cash', currency: 'THB' },
            fundAmount: 365,
            category: { name: 'Food' },
            tags: []
        });
        expect(coffee.id).toEqual(expect.any(String));
        expect(new Date(coffee.date).toISOString()).toBe('2026-08-20T05:00:00.000Z');
    });

    test('list_expenses: filters by period (dateTo exclusive, bare dates in Bangkok), category, fund, tag and limit', async () => {
        const september = await call(client, 'list_expenses', { dateFrom: '2026-09-01', dateTo: '2026-10-01' });

        expect(september.data.expenses.map(cost => cost.comment)).toEqual(['Bus', 'Noodles']);

        const food = await call(client, 'list_expenses', { category: 'food' });

        expect(food.data.expenses.map(cost => cost.comment)).toEqual(['Noodles', 'Coffee']);

        const card = await call(client, 'list_expenses', { fund: 'CARD' });

        expect(card.data.expenses).toEqual([]);

        const tagged = await call(client, 'list_expenses', { tag: 'Bangkok' });

        expect(tagged.data.expenses.map(cost => cost.comment)).toEqual(['Noodles']);

        const limited = await call(client, 'list_expenses', { limit: 2 });

        expect(limited.data.count).toBe(2);
        expect(limited.data.truncated).toBe(true);
    });

    test('list_expenses: an unknown category is an error listing the available ones', async () => {
        const { result, text } = await call(client, 'list_expenses', { category: 'Groceries' });

        expect(result.isError).toBe(true);
        expect(text).toContain('Food');
        expect(text).toContain('Transport');
        expect(text).not.toContain('B-secret');
    });

    test('get_summary: exactly GET /api/analytics/summary', async () => {
        const { data } = await call(client, 'get_summary', { dateFrom: '2026-09-01', dateTo: '2026-10-01' });
        const rest = await request(app)
            .get('/api/analytics/summary')
            .query({ dateFrom: '2026-09-01T00:00:00+07:00', dateTo: '2026-10-01T00:00:00+07:00' })
            .set(bearer(a.user));

        expect(rest.status).toBe(200);
        expect(JSON.parse(JSON.stringify(data))).toEqual(rest.body);
        expect(data).toMatchObject({ currency: 'THB', total: 160, count: 2 });
        // A bare month is a Bangkok calendar month, so it is compared with the previous calendar month
        expect(data.previous).toMatchObject({ total: 365, count: 1 });
    });

    test('get_summary: a bad period is a tool error', async () => {
        const { result, text } = await call(client, 'get_summary', { dateFrom: '2026-10-01', dateTo: '2026-09-01' });

        expect(result.isError).toBe(true);
        expect(text).toContain('dateTo must be after dateFrom');
    });

    test('get_monthly_trend: exactly GET /api/analytics/monthly', async () => {
        const { data } = await call(client, 'get_monthly_trend', { months: 6 });
        const rest = await request(app).get('/api/analytics/monthly').query({ months: '6' }).set(bearer(a.user));

        expect(JSON.parse(JSON.stringify(data))).toEqual(rest.body);
        expect(data.months).toHaveLength(6);
    });

    test('nothing of another user is visible through any read tool', async () => {
        const outputs = [
            await call(client, 'get_profile'),
            await call(client, 'list_categories'),
            await call(client, 'list_funds'),
            await call(client, 'list_tags'),
            await call(client, 'list_expenses', { limit: 500 }),
            await call(client, 'get_summary', { dateFrom: '2026-01-01', dateTo: '2027-01-01' }),
            await call(client, 'get_monthly_trend', { months: 24 })
        ].map(output => output.text).join('\n');

        for (const secret of ['B-secret', 'b-secret', String(b.food._id), String(b.cash._id), '777', '9999', b.user.username]) {
            expect(outputs).not.toContain(secret);
        }

        // Asking for B's category or fund by id or name finds nothing and lists only A's
        for (const args of [{ category: String(b.food._id) }, { category: 'B-secret-category' }, { fund: 'B-secret-fund' }]) {
            const { result, text } = await call(client, 'list_expenses', args);

            expect(result.isError).toBe(true);
            expect(text.split('Available')[1]).not.toMatch(/B-secret|777|9999/);
        }
    });
});

describe('write tools', () => {
    let client;

    beforeEach(async () => {
        client = await mcpClient((await connect(a.user, { allowWrite: true })).tokens.access_token);
    });

    test('add_expense: 1500 JPY from a THB fund debits the converted amount', async () => {
        const { result, data } = await call(client, 'add_expense', {
            amount: 1500,
            currency: 'jpy',
            category: 'food',
            fund: 'cash',
            comment: 'Ramen',
            tags: ['Japan 2026']
        });

        expect(result.isError).toBeFalsy();
        expect(data.summary).toBe(`1500 JPY → ${RAMEN_IN_THB} THB · Cash · #japan-2026`);
        expect(data.currency).toBe('THB');
        expect(data.expense).toMatchObject({
            amount: 1500,
            currency: 'JPY',
            amountInUserCurrency: 367,
            fund: { name: 'Cash', currency: 'THB' },
            fundAmount: RAMEN_IN_THB,
            category: { name: 'Food' },
            tags: ['japan-2026'],
            comment: 'Ramen'
        });

        expect((await Fund.findById(a.cash._id)).currentBalance).toBeCloseTo(5000 - RAMEN_IN_THB, 2);

        const saved = await Cost.findById(data.expense.id);

        expect(String(saved.user)).toBe(String(a.user._id));
        expect(saved.fundAmount).toBe(RAMEN_IN_THB);
        expect(await FundTransaction.countDocuments({ fundId: a.cash._id, amount: -RAMEN_IN_THB })).toBe(1);
    });

    test('add_expense: the active tag is applied when tags are absent; the default is today', async () => {
        await call(client, 'set_active_tag', { tag: 'Japan 2026' });

        const { data } = await call(client, 'add_expense', { amount: 50, category: 'Transport' });

        expect(data.expense.tags).toEqual(['japan-2026']);
        expect(data.expense.fund).toBeNull();
        expect(data.summary).toBe('50 THB · #japan-2026');
        expect(Math.abs(new Date(data.expense.date) - Date.now())).toBeLessThan(60 * 1000);
    });

    test('add_expense: tags: [] means no tags even with an active tag', async () => {
        await User.updateOne({ _id: a.user._id }, { activeTag: 'japan-2026' });

        const fresh = await mcpClient((await connect(a.user, { allowWrite: true })).tokens.access_token);
        const { data } = await call(fresh, 'add_expense', { amount: 50, category: 'Transport', tags: [] });

        expect(data.expense.tags).toEqual([]);
    });

    test('add_expense: an unknown category is an error listing the categories, nothing written', async () => {
        const { result, text } = await call(client, 'add_expense', { amount: 50, category: 'Groceries', fund: 'Cash' });

        expect(result.isError).toBe(true);
        expect(text).toContain('Unknown category "Groceries"');
        expect(text).toContain('Food');
        expect(text).toContain('Transport');
        expect(await Cost.countDocuments()).toBe(0);
        expect((await Fund.findById(a.cash._id)).currentBalance).toBe(5000);
    });

    test('add_expense: an unknown fund is an error listing the funds', async () => {
        const { result, text } = await call(client, 'add_expense', { amount: 50, category: 'Food', fund: 'Wallet' });

        expect(result.isError).toBe(true);
        expect(text).toContain('Unknown fund "Wallet"');
        expect(text).toContain('Cash');
        expect(text).toContain('Card');
        expect(await Cost.countDocuments()).toBe(0);
    });

    test('add_expense: another user\'s category or fund, by id or name, is unknown', async () => {
        for (const args of [
            { amount: 50, category: String(b.food._id) },
            { amount: 50, category: 'B-secret-category' },
            { amount: 50, category: 'Food', fund: String(b.cash._id) },
            { amount: 50, category: 'Food', fund: 'B-secret-fund' }
        ]) {
            const { result, text } = await call(client, 'add_expense', args);

            expect(result.isError).toBe(true);
            // The error lists only A's categories and funds; it repeats what was asked for, nothing more
            expect(text.split('Available')[1]).not.toContain('B-secret');
        }

        expect(await Cost.countDocuments()).toBe(0);
        expect((await Fund.findById(b.cash._id)).currentBalance).toBe(9999);
    });

    test('add_expense: insufficient funds is a tool error with the message, balance untouched', async () => {
        const { result, text } = await call(client, 'add_expense', { amount: 500, category: 'Food', fund: 'Card' });

        expect(result.isError).toBe(true);
        expect(text).toBe('Insufficient funds');
        expect((await Fund.findById(a.card._id)).currentBalance).toBe(100);
        expect(await Cost.countDocuments()).toBe(0);
    });

    test('add_expense: a non-positive amount is refused', async () => {
        expect(await callRefused(client, 'add_expense', { amount: 0, category: 'Food' })).toBe(true);
        expect(await callRefused(client, 'add_expense', { amount: -5, category: 'Food' })).toBe(true);
        expect(await Cost.countDocuments()).toBe(0);
    });

    test('set_active_tag: sets and clears the tag', async () => {
        const set = await call(client, 'set_active_tag', { tag: 'Japan 2026' });

        expect(set.data).toEqual({ activeTag: 'japan-2026' });
        expect((await User.findById(a.user._id)).activeTag).toBe('japan-2026');

        const cleared = await call(client, 'set_active_tag', { tag: null });

        expect(cleared.data).toEqual({ activeTag: null });
        expect((await User.findById(a.user._id)).activeTag).toBeNull();
    });
});

describe('a read-only token cannot write', () => {
    test('add_expense and set_active_tag are refused and nothing changes', async () => {
        const client = await mcpClient((await connect(a.user)).tokens.access_token);

        expect(await callRefused(client, 'add_expense', { amount: 50, category: 'Food', fund: 'Cash' })).toBe(true);
        expect(await callRefused(client, 'set_active_tag', { tag: 'x' })).toBe(true);

        expect(await Cost.countDocuments()).toBe(0);
        expect((await Fund.findById(a.cash._id)).currentBalance).toBe(5000);
        expect((await User.findById(a.user._id)).activeTag).toBeNull();
    });
});
