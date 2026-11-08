const request = require('supertest');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const app = require('../app');
const ExchangeRate = require('../models/ExchangeRate');
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const loginGuard = require('../utils/loginGuard');
const { seedUser, seedFund, seedCategory, bearer } = require('./helpers');
const { connect } = require('./oauth.helpers');

// Managing funds through MCP: every tool goes through the same rules as the REST routes, against the database

// 1 USD = 36.5 THB = 149.3 JPY
const RATES = [['THB', 36.5], ['JPY', 149.3]];

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

const callRefused = async (client, name, args) => {
    try {
        return (await client.callTool({ name, arguments: args })).isError === true;
    } catch (error) {
        return true;
    }
};

const balanceOf = async (fund) => (await Fund.findById(fund._id)).currentBalance;

let a;
let b;
let client;

beforeEach(async () => {
    loginGuard.reset();
    await ExchangeRate.create({ base: 'USD', rates: new Map(RATES) });

    a = { user: await seedUser({ defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ defaultCurrency: 'THB' }) };

    a.food = await seedCategory(a.user, { name: 'Food' });
    a.cash = await seedFund(a.user, { name: 'Cash', currency: 'THB', initialBalance: 5000, currentBalance: 5000, isDefault: true });
    a.yen = await seedFund(a.user, { name: 'Yen', currency: 'JPY', initialBalance: 0, currentBalance: 0 });
    b.cash = await seedFund(b.user, { name: 'B-secret-fund', currency: 'THB', initialBalance: 9999, currentBalance: 9999 });

    client = await mcpClient((await connect(a.user, { allowWrite: true })).tokens.access_token);
});

describe('create_fund', () => {
    test('an account in the default currency, with an icon name; listed by list_funds and GET /api/funds', async () => {
        const { data } = await call(client, 'create_fund', { name: 'Card', initialBalance: 1200, icon: 'credit-card' });

        expect(data.summary).toBe('Card: 1200 THB');
        expect(data.fund).toMatchObject({ name: 'Card', currency: 'THB', balance: 1200, kind: 'account', goal: null, isDefault: false });

        const saved = await Fund.findById(data.fund.id);

        expect(saved.userId.equals(a.user._id)).toBe(true);
        expect(saved.icon).toBe('mdi-credit-card');
        expect(saved.initialBalance).toBe(1200);
        // Creating a fund writes no history, so it can still be deleted
        expect(await FundTransaction.countDocuments({ fundId: saved._id })).toBe(0);

        const listed = (await call(client, 'list_funds')).data;

        expect(listed.funds.map(fund => fund.name)).toContain('Card');
        expect(listed.total.amount).toBe(5000 + 1200);

        const rest = await request(app).get('/api/funds').set(bearer(a.user));

        expect(rest.body.funds.map(fund => fund.name)).toContain('Card');
    });

    test('a savings fund with a goal; a bare goal date is Bangkok midnight; currency is upper-cased', async () => {
        const { data } = await call(client, 'create_fund', {
            name: 'Japan trip', currency: 'jpy', kind: 'savings', icon: 'mdi-piggy-bank',
            goal: { amount: 300000, date: '2027-03-01' }
        });

        expect(data.fund).toMatchObject({ currency: 'JPY', balance: 0, kind: 'savings', goal: { amount: 300000 } });
        expect(data.fund.goalProgress).toMatchObject({ remaining: 300000, reached: false });
        expect(data.summary).toBe('Japan trip: 0 JPY · savings · goal 300000 JPY');

        const saved = await Fund.findById(data.fund.id);

        expect(saved.goal.date.toISOString()).toBe('2027-02-28T17:00:00.000Z');
        expect(saved.icon).toBe('mdi-piggy-bank');
    });

    test('the REST rules apply: a goal on an account, a savings default and a bad goal date are refused, nothing written', async () => {
        const before = await Fund.countDocuments();

        const goalOnAccount = await call(client, 'create_fund', { name: 'X', goal: { amount: 10 } });
        const savingsDefault = await call(client, 'create_fund', { name: 'X', kind: 'savings', isDefault: true });
        const badDate = await call(client, 'create_fund', { name: 'X', kind: 'savings', goal: { amount: 10, date: 'soon' } });

        expect(goalOnAccount.text).toBe('Only a savings fund can have a goal');
        expect(savingsDefault.text).toBe('A savings fund cannot be the default');
        expect(badDate.text).toContain('goal.date is not a valid date');
        expect(await Fund.countDocuments()).toBe(before);
    });

    test('a negative balance, an empty name or a bad currency never reach the database', async () => {
        const before = await Fund.countDocuments();

        expect(await callRefused(client, 'create_fund', { name: 'X', initialBalance: -1 })).toBe(true);
        expect(await callRefused(client, 'create_fund', { name: '  ' })).toBe(true);
        expect(await callRefused(client, 'create_fund', { name: 'X', currency: 'BAHT' })).toBe(true);
        expect(await Fund.countDocuments()).toBe(before);
    });
});

describe('update_fund', () => {
    test('renaming leaves the balance, currency and the other fields alone', async () => {
        const { data } = await call(client, 'update_fund', { fund: 'cash', name: 'Wallet' });

        expect(data.fund).toMatchObject({ name: 'Wallet', balance: 5000, currency: 'THB', isDefault: true });
        expect(data.balanceChange).toBeUndefined();

        const saved = await Fund.findById(a.cash._id);

        expect(saved.name).toBe('Wallet');
        expect(saved.currentBalance).toBe(5000);
        expect(saved.currency).toBe('THB');
    });

    test('a new balance is a manual adjustment in the history, as on the web', async () => {
        const { data } = await call(client, 'update_fund', { fund: 'Cash', balance: 4250.5 });

        expect(data.balanceChange).toEqual({ from: 5000, to: 4250.5, currency: 'THB' });
        expect(await balanceOf(a.cash)).toBe(4250.5);

        const adjustments = await FundTransaction.find({ fundId: a.cash._id, type: 'adjustment' });

        expect(adjustments.map(t => t.amount)).toEqual([-749.5]);
    });

    test('kind and goal: account → savings with a goal drops the default flag; back to account clears the goal; goal null clears it', async () => {
        const toSavings = (await call(client, 'update_fund', { fund: 'Cash', kind: 'savings', goal: { amount: 10000 } })).data;

        expect(toSavings.fund).toMatchObject({ kind: 'savings', isDefault: false, goal: { amount: 10000 } });
        expect(toSavings.fund.goalProgress).toMatchObject({ percent: 50, remaining: 5000 });

        const cleared = (await call(client, 'update_fund', { fund: 'Cash', goal: null })).data;

        expect(cleared.fund.goal).toBeNull();

        await call(client, 'update_fund', { fund: 'Cash', goal: { amount: 7000 } });
        const back = (await call(client, 'update_fund', { fund: 'Cash', kind: 'account' })).data;

        expect(back.fund).toMatchObject({ kind: 'account', goal: null });
    });

    test('refusals: a goal on an account, an archived fund as default, an unknown fund', async () => {
        await Fund.updateOne({ _id: a.yen._id }, { archivedAt: new Date() });

        expect((await call(client, 'update_fund', { fund: 'Cash', goal: { amount: 1 } })).text).toBe('Only a savings fund can have a goal');
        expect((await call(client, 'update_fund', { fund: 'Yen', isDefault: true })).text).toBe('Fund is archived');

        const unknown = await call(client, 'update_fund', { fund: 'Bank', name: 'X' });

        expect(unknown.result.isError).toBe(true);
        expect(unknown.text).toContain('Unknown fund "Bank"');
        expect(unknown.text).toContain('Cash');
        expect((await Fund.findById(a.cash._id)).toObject()).toMatchObject({ name: 'Cash', currentBalance: 5000 });
    });

    test('an archived fund can still be renamed', async () => {
        await Fund.updateOne({ _id: a.yen._id }, { archivedAt: new Date() });

        const { data } = await call(client, 'update_fund', { fund: 'Yen', name: 'Old yen' });

        expect(data.fund).toMatchObject({ name: 'Old yen', archived: true });
    });
});

describe('archive_fund and restore_fund', () => {
    test('archive hides the fund from the list and the total, clears the default flag; restore brings it back; both idempotent', async () => {
        const archived = (await call(client, 'archive_fund', { fund: 'Cash' })).data;

        expect(archived.fund).toMatchObject({ archived: true, isDefault: false, balance: 5000 });
        expect(archived.summary).toBe('Cash: 5000 THB · archived');

        const archivedAt = (await Fund.findById(a.cash._id)).archivedAt;

        expect(archivedAt).toBeInstanceOf(Date);

        const listed = (await call(client, 'list_funds')).data;

        expect(listed.funds.map(fund => fund.name)).toEqual(['Yen']);
        expect(listed.total.amount).toBe(0);

        // Archiving again keeps the original date
        await call(client, 'archive_fund', { fund: 'Cash' });
        expect((await Fund.findById(a.cash._id)).archivedAt).toEqual(archivedAt);

        const restored = (await call(client, 'restore_fund', { fund: 'Cash' })).data;

        expect(restored.fund.archived).toBeUndefined();
        expect((await Fund.findById(a.cash._id)).archivedAt).toBeNull();
        expect((await call(client, 'restore_fund', { fund: 'Cash' })).result.isError).toBeFalsy();
        expect((await call(client, 'list_funds')).data.total.amount).toBe(5000);
    });

    test('an archived fund takes no expense', async () => {
        await call(client, 'archive_fund', { fund: 'Cash' });

        const { result } = await call(client, 'add_expense', { amount: 10, category: 'Food', fund: 'Cash' });

        expect(result.isError).toBe(true);
        expect(await balanceOf(a.cash)).toBe(5000);
    });
});

describe('delete_fund', () => {
    test('a fund with no history is deleted', async () => {
        const created = (await call(client, 'create_fund', { name: 'Mistake' })).data;

        const { data } = await call(client, 'delete_fund', { fund: 'Mistake' });

        expect(data.deleted).toEqual({ id: created.fund.id, name: 'Mistake' });
        expect(await Fund.findById(created.fund.id)).toBeNull();
    });

    test('a fund with an expense, a transfer or a correction is refused with a hint to archive, and nothing is removed', async () => {
        await call(client, 'add_expense', { amount: 10, category: 'Food', fund: 'Cash' });
        const withCost = await call(client, 'delete_fund', { fund: 'Cash' });

        expect(withCost.result.isError).toBe(true);
        expect(withCost.text).toContain('has history');
        expect(withCost.text).toContain('archive_fund');
        expect(await Fund.findById(a.cash._id)).not.toBeNull();

        const corrected = (await call(client, 'create_fund', { name: 'Corrected' })).data.fund;
        await call(client, 'update_fund', { fund: 'Corrected', balance: 5 });

        expect((await call(client, 'delete_fund', { fund: 'Corrected' })).text).toContain('has history');

        const before = await FundTransaction.countDocuments();
        expect((await call(client, 'delete_fund', { fund: corrected.id })).result.isError).toBe(true);
        expect(await FundTransaction.countDocuments()).toBe(before);
    });

    test('an archived fund without history can be deleted', async () => {
        await call(client, 'archive_fund', { fund: 'Yen' });

        expect((await call(client, 'delete_fund', { fund: 'Yen' })).data.deleted.name).toBe('Yen');
        expect(await Fund.findById(a.yen._id)).toBeNull();
    });
});

describe('transfer_funds', () => {
    test('THB to JPY: the source is debited the amount, the target credited the converted amount, both recorded', async () => {
        const { data } = await call(client, 'transfer_funds', { from: 'Cash', to: 'Yen', amount: 1000, comment: 'Exchange' });

        // 1000 THB × 149.3 / 36.5, JPY has no minor unit
        const credited = Math.round(1000 * 149.3 / 36.5);

        expect(data.withdrawn).toEqual({ amount: 1000, currency: 'THB' });
        expect(data.credited).toEqual({ amount: credited, currency: 'JPY' });
        expect(data.summary).toBe(`1000 THB → ${credited} JPY · Cash → Yen`);
        expect(data.from.balance).toBe(4000);
        expect(data.to.balance).toBe(credited);

        expect(await balanceOf(a.cash)).toBe(4000);
        expect(await balanceOf(a.yen)).toBe(credited);

        const transactions = await FundTransaction.find({ userId: a.user._id }).sort({ amount: 1 });

        expect(transactions.map(t => [String(t.fundId), t.type, t.amount, t.description])).toEqual([
            [String(a.cash._id), 'transfer-out', -1000, 'Exchange'],
            [String(a.yen._id), 'transfer-in', credited, 'Exchange']
        ]);
    });

    test('the same result as the REST transfer', async () => {
        const viaMcp = (await call(client, 'transfer_funds', { from: 'Cash', to: 'Yen', amount: 333 })).data;
        const viaRest = await request(app).post('/api/funds/transfer').set(bearer(a.user))
            .send({ fromFundId: String(a.cash._id), toFundId: String(a.yen._id), amount: 333 });

        expect(viaRest.status).toBe(200);
        expect({ withdrawn: viaMcp.withdrawn, credited: viaMcp.credited, rate: viaMcp.rate })
            .toEqual({ withdrawn: viaRest.body.withdrawn, credited: viaRest.body.credited, rate: viaRest.body.rate });
    });

    test('refusals leave both balances: insufficient money, same fund, archived fund', async () => {
        expect((await call(client, 'transfer_funds', { from: 'Cash', to: 'Yen', amount: 5000.01 })).text)
            .toBe('Insufficient amount of money in source fund');
        expect((await call(client, 'transfer_funds', { from: 'Cash', to: 'cash', amount: 1 })).text)
            .toBe('Funds must be different');

        await call(client, 'archive_fund', { fund: 'Yen' });

        expect((await call(client, 'transfer_funds', { from: 'Cash', to: 'Yen', amount: 1 })).text)
            .toBe('An archived fund cannot take part in a transfer');
        expect(await callRefused(client, 'transfer_funds', { from: 'Cash', to: 'Yen', amount: -1 })).toBe(true);

        expect(await balanceOf(a.cash)).toBe(5000);
        expect(await balanceOf(a.yen)).toBe(0);
        expect(await FundTransaction.countDocuments()).toBe(0);
    });
});

describe('another user\'s fund', () => {
    test('is unknown to every fund tool, by name or by id, and is never changed', async () => {
        const otherId = String(b.cash._id);

        for (const ref of ['B-secret-fund', otherId]) {
            for (const [name, args] of [
                ['update_fund', { fund: ref, name: 'Mine', balance: 0 }],
                ['archive_fund', { fund: ref }],
                ['restore_fund', { fund: ref }],
                ['delete_fund', { fund: ref }],
                ['transfer_funds', { from: ref, to: 'Cash', amount: 1 }],
                ['transfer_funds', { from: 'Cash', to: ref, amount: 1 }]
            ]) {
                const { result, text } = await call(client, name, args);

                expect(result.isError).toBe(true);
                expect(text).toContain('Unknown fund');
                // The list of what there is never names the other user's fund
                expect(text.split('Available funds:')[1]).not.toContain('B-secret-fund');
            }
        }

        const untouched = await Fund.findById(b.cash._id);

        expect(untouched.toObject()).toMatchObject({ name: 'B-secret-fund', currentBalance: 9999, archivedAt: null });
        expect(await balanceOf(a.cash)).toBe(5000);
        expect(await FundTransaction.countDocuments()).toBe(0);
    });

    test('create_fund makes the fund the caller\'s, never another user\'s', async () => {
        await call(client, 'create_fund', { name: 'Mine' });

        expect(await Fund.countDocuments({ userId: b.user._id })).toBe(1);
        expect(await Fund.countDocuments({ userId: a.user._id, name: 'Mine' })).toBe(1);
    });
});

describe('a read-only token', () => {
    test('does not list the fund tools and cannot use them; nothing changes', async () => {
        const readOnly = await mcpClient((await connect(a.user)).tokens.access_token);
        const names = (await readOnly.listTools()).tools.map(tool => tool.name);

        for (const name of ['create_fund', 'update_fund', 'archive_fund', 'restore_fund', 'delete_fund', 'transfer_funds']) {
            expect(names).not.toContain(name);
        }

        expect(await callRefused(readOnly, 'create_fund', { name: 'X' })).toBe(true);
        expect(await callRefused(readOnly, 'update_fund', { fund: 'Cash', balance: 0 })).toBe(true);
        expect(await callRefused(readOnly, 'archive_fund', { fund: 'Cash' })).toBe(true);
        expect(await callRefused(readOnly, 'delete_fund', { fund: 'Yen' })).toBe(true);
        expect(await callRefused(readOnly, 'transfer_funds', { from: 'Cash', to: 'Yen', amount: 1 })).toBe(true);

        expect(await Fund.countDocuments({ userId: a.user._id })).toBe(2);
        expect((await Fund.findById(a.cash._id)).toObject()).toMatchObject({ currentBalance: 5000, archivedAt: null });
        expect(await FundTransaction.countDocuments()).toBe(0);
    });
});

describe('tool annotations', () => {
    test('delete_fund and update_fund are marked destructive, so Claude asks before calling them', async () => {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));

        expect(byName.delete_fund.annotations.destructiveHint).toBe(true);
        expect(byName.update_fund.annotations.destructiveHint).toBe(true);
        expect(byName.archive_fund.annotations.destructiveHint).toBe(false);
    });
});
