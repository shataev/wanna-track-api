const request = require('supertest');
const app = require('../app');
const Fund = require('../models/Fund');
const ExchangeRate = require('../models/ExchangeRate');
const { goalProgress } = require('../utils/fund.utils');
const { seedUser, seedFund, seedCategory, bearer, botHeaders } = require('./helpers');

let user;
let other;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map([['THB', 36.5], ['JPY', 150]]) });

    user = await seedUser({ telegramId: '1001', defaultCurrency: 'THB' });
    other = await seedUser({ telegramId: '2002', defaultCurrency: 'THB' });
});

afterEach(() => {
    jest.useRealTimers();
});

// Only Date is faked: the database driver keeps its real timers
const freezeDate = (iso) => jest.useFakeTimers({
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout'],
    now: new Date(iso)
});

const as = (u = user) => bearer(u);
const createFund = (body, u = user) => request(app).post('/api/funds').set(as(u)).send({
    name: 'Trip', initialBalance: 12000, currency: 'THB', ...body
});
const updateFund = (fund, body, u = user) => request(app).put(`/api/funds/${fund._id ?? fund.id}`).set(as(u)).send(body);
const getFund = (id) => request(app).get(`/api/funds/${id}`).set(as());

describe('kind', () => {
    it('a fund saved before kind existed reads as an account, in the list and by id', async () => {
        const fund = await seedFund(user);
        await Fund.collection.updateOne({ _id: fund._id }, { $unset: { kind: '', goal: '' } });

        const list = await request(app).get('/api/funds').set(as()).expect(200);
        expect(list.body.funds[0]).toMatchObject({ kind: 'account', goal: null });
        expect(list.body.funds[0].goalProgress).toBeUndefined();

        const one = await getFund(fund._id).expect(200);
        expect(one.body).toMatchObject({ kind: 'account', goal: null });
    });

    it('is account unless asked, and savings when asked', async () => {
        const plain = await createFund({}).expect(201);
        const savings = await createFund({ kind: 'savings' }).expect(201);

        expect(plain.body.kind).toBe('account');
        expect(savings.body.kind).toBe('savings');
        expect((await Fund.findById(savings.body._id)).kind).toBe('savings');
    });

    it('rejects an unknown kind on create and on edit', async () => {
        await createFund({ kind: 'envelope' }).expect(400);
        const fund = await seedFund(user);
        await updateFund(fund, { kind: 'envelope' }).expect(400);
        expect((await Fund.findById(fund._id)).kind).toBe('account');
    });

    it('can be changed when editing', async () => {
        const fund = await seedFund(user);

        const res = await updateFund(fund, { kind: 'savings' }).expect(200);

        expect(res.body.kind).toBe('savings');
        expect((await Fund.findById(fund._id)).kind).toBe('savings');
    });

    it('an edit that does not mention kind keeps it', async () => {
        const fund = await seedFund(user, { kind: 'savings' });

        await updateFund(fund, { name: 'Renamed' }).expect(200);

        expect((await Fund.findById(fund._id)).kind).toBe('savings');
    });
});

describe('goal', () => {
    it('is set with an amount and a date, changed, and cleared with null', async () => {
        const created = await createFund({ kind: 'savings', goal: { amount: 30000, date: '2027-03-15' } }).expect(201);

        expect(created.body.goal).toMatchObject({ amount: 30000 });
        expect(new Date(created.body.goal.date).toISOString()).toBe('2027-03-15T00:00:00.000Z');

        const changed = await updateFund(created.body, { goal: { amount: 40000 } }).expect(200);
        expect(changed.body.goal).toEqual({ amount: 40000, date: null });

        const cleared = await updateFund(created.body, { goal: null }).expect(200);
        expect(cleared.body.goal).toBeNull();
        expect(cleared.body.goalProgress).toBeUndefined();
        expect((await Fund.findById(created.body._id)).goal).toBeNull();
    });

    it('is optional: a savings fund without one has none', async () => {
        const res = await createFund({ kind: 'savings' }).expect(201);

        expect(res.body.goal).toBeNull();
        expect(res.body.goalProgress).toBeUndefined();
    });

    it('rejects a bad amount or date with 400 and saves nothing', async () => {
        for (const goal of [{ amount: 0 }, { amount: -5 }, { amount: 'lots' }, { amount: null }, {}, { amount: 100, date: 'someday' },
            { amount: 100, date: {} }, 'x', [100]]) {
            await createFund({ kind: 'savings', goal }).expect(400);
        }

        expect(await Fund.countDocuments({ userId: user._id })).toBe(0);

        const fund = await seedFund(user, { kind: 'savings' });
        await updateFund(fund, { goal: { amount: 0 } }).expect(400);
        await updateFund(fund, { goal: { amount: 100, date: 'someday' } }).expect(400);
        expect((await Fund.findById(fund._id)).goal).toBeNull();
    });

    it('is refused on an account, on create and on edit', async () => {
        await createFund({ goal: { amount: 100 } }).expect(400);
        await createFund({ kind: 'account', goal: { amount: 100 } }).expect(400);

        const account = await seedFund(user);
        await updateFund(account, { goal: { amount: 100 } }).expect(400);
        expect((await Fund.findById(account._id)).goal).toBeNull();

        // ... but null is fine on an account: it is already cleared
        await updateFund(account, { goal: null }).expect(200);
    });

    it('turning a savings fund into an account clears its goal; a goal in the same request is refused', async () => {
        const savings = await createFund({ kind: 'savings', goal: { amount: 30000, date: '2027-03-15' } }).expect(201);

        await updateFund(savings.body, { kind: 'account', goal: { amount: 1 } }).expect(400);
        expect((await Fund.findById(savings.body._id)).goal).not.toBeNull();

        const res = await updateFund(savings.body, { kind: 'account' }).expect(200);

        expect(res.body.kind).toBe('account');
        expect(res.body.goal).toBeNull();
        expect(res.body.goalProgress).toBeUndefined();
        expect((await Fund.findById(savings.body._id)).goal).toBeNull();
    });

    it('can be given while turning an account into savings', async () => {
        const account = await seedFund(user);

        const res = await updateFund(account, { kind: 'savings', goal: { amount: 5000 } }).expect(200);

        expect(res.body).toMatchObject({ kind: 'savings', goal: { amount: 5000, date: null } });
    });
});

describe('isDefault', () => {
    it('making a fund savings clears its default flag', async () => {
        const fund = await seedFund(user, { isDefault: true });

        const res = await updateFund(fund, { kind: 'savings' }).expect(200);

        expect(res.body.isDefault).toBe(false);
        expect((await Fund.findById(fund._id)).isDefault).toBe(false);
    });

    it('a savings fund cannot be set as default: on create, on edit, and together with the kind change', async () => {
        await createFund({ kind: 'savings', isDefault: true }).expect(400);

        const savings = await seedFund(user, { kind: 'savings' });
        await updateFund(savings, { isDefault: true }).expect(400);

        const account = await seedFund(user, { name: 'Card' });
        await updateFund(account, { kind: 'savings', isDefault: true }).expect(400);

        expect((await Fund.findById(savings._id)).isDefault).toBe(false);
        expect((await Fund.findById(account._id)).kind).toBe('account');
        expect(await Fund.countDocuments({ userId: user._id })).toBe(2);
    });

    it('an account can still be the default', async () => {
        const res = await createFund({ isDefault: true }).expect(201);

        expect(res.body.isDefault).toBe(true);
    });
});

describe('goalProgress (pure)', () => {
    // 2026-11-05 12:00 Bangkok
    const NOW = new Date('2026-11-05T05:00:00Z').getTime();
    const fund = (currentBalance, goal) => ({ currentBalance, goal });

    it('without a date: percent, remaining, reached; no months, no monthly amount', () => {
        expect(goalProgress(fund(12000, { amount: 30000, date: null }), NOW)).toEqual({
            percent: 40, remaining: 18000, monthsLeft: null, perMonth: null, reached: false
        });
    });

    it('with a date: months from the current Bangkok month up to and including the target month', () => {
        // Nov 2026 .. Mar 2027 = 5 months; 18000 / 5 = 3600
        expect(goalProgress(fund(12000, { amount: 30000, date: new Date('2027-03-15T00:00:00Z') }), NOW)).toMatchObject({
            monthsLeft: 5, perMonth: 3600
        });
    });

    it('rounds the monthly amount up to whole units', () => {
        // 18000 / 4 months (Nov..Feb) = 4500 exactly; 18001 / 4 = 4500.25 -> 4501
        expect(goalProgress(fund(11999, { amount: 30000, date: new Date('2027-02-10T00:00:00Z') }), NOW)).toMatchObject({
            monthsLeft: 4, remaining: 18001, perMonth: 4501
        });
        expect(goalProgress(fund(12000, { amount: 30000, date: new Date('2027-02-10T00:00:00Z') }), NOW).perMonth).toBe(4500);
    });

    it('a target in the current month, or in the past, counts as one month', () => {
        expect(goalProgress(fund(0, { amount: 900, date: new Date('2026-11-28T00:00:00Z') }), NOW)).toMatchObject({ monthsLeft: 1, perMonth: 900 });
        expect(goalProgress(fund(0, { amount: 900, date: new Date('2026-01-01T00:00:00Z') }), NOW)).toMatchObject({ monthsLeft: 1, perMonth: 900 });
    });

    it('reached: remaining 0, percent exactly 100 at the target and above it beyond', () => {
        expect(goalProgress(fund(30000, { amount: 30000, date: new Date('2027-03-15T00:00:00Z') }), NOW)).toEqual({
            percent: 100, remaining: 0, monthsLeft: 5, perMonth: 0, reached: true
        });

        const over = goalProgress(fund(45000, { amount: 30000, date: null }), NOW);
        expect(over).toMatchObject({ percent: 150, remaining: 0, reached: true });
    });

    it('is null without a goal', () => {
        expect(goalProgress(fund(100, null), NOW)).toBeNull();
        expect(goalProgress(fund(100, undefined), NOW)).toBeNull();
    });

    it('the month turns at midnight in Bangkok, not in UTC', () => {
        const goal = { amount: 1000, date: new Date('2026-12-20T00:00:00Z') };
        // 2026-10-31 23:59:59 Bangkok is still October: Oct..Dec = 3 months
        expect(goalProgress(fund(0, goal), new Date('2026-10-31T16:59:59Z').getTime()).monthsLeft).toBe(3);
        // one second later it is 2026-11-01 00:00:00 in Bangkok: Nov..Dec = 2 months (UTC would still say October)
        expect(goalProgress(fund(0, goal), new Date('2026-10-31T17:00:00Z').getTime()).monthsLeft).toBe(2);
    });

    it('the target date is read in Bangkok too: 2026-12-31 18:00Z is January there', () => {
        const goal = { amount: 1000, date: new Date('2026-12-31T18:00:00Z') };

        expect(goalProgress(fund(0, goal), NOW).monthsLeft).toBe(3); // Nov, Dec, Jan
    });
});

describe('goalProgress in the responses', () => {
    it('is on the list, by id and in the archive, from the balance and the clock', async () => {
        freezeDate('2026-11-05T05:00:00Z');
        const created = await createFund({ kind: 'savings', goal: { amount: 30000, date: '2027-03-15' } }).expect(201);
        const expected = { percent: 40, remaining: 18000, monthsLeft: 5, perMonth: 3600, reached: false };

        expect(created.body.goalProgress).toEqual(expected);

        const list = await request(app).get('/api/funds').set(as()).expect(200);
        expect(list.body.funds[0]).toMatchObject({ kind: 'savings', goal: { amount: 30000 }, goalProgress: expected });

        expect((await getFund(created.body._id).expect(200)).body.goalProgress).toEqual(expected);

        await request(app).post(`/api/funds/${created.body._id}/archive`).set(as()).expect(200);
        const archived = await request(app).get('/api/funds?archived=true').set(as()).expect(200);
        expect(archived.body.funds[0]).toMatchObject({ kind: 'savings', goalProgress: expected });
    });

    it('follows the balance: a transfer into the fund moves the progress', async () => {
        freezeDate('2026-11-05T05:00:00Z');
        const card = await seedFund(user, { name: 'Card', currency: 'THB', initialBalance: 50000, currentBalance: 50000 });
        const savings = await createFund({ kind: 'savings', initialBalance: 0, goal: { amount: 30000 } }).expect(201);

        await request(app).post('/api/funds/transfer').set(as())
            .send({ fromFundId: String(card._id), toFundId: savings.body._id, amount: 30000 }).expect(200);

        const res = await getFund(savings.body._id).expect(200);
        expect(res.body.currentBalance).toBe(30000);
        expect(res.body.goalProgress).toMatchObject({ percent: 100, remaining: 0, reached: true });
    });

    it('does not leak across users: B cannot read or edit the goal of A', async () => {
        const created = await createFund({ kind: 'savings', goal: { amount: 30000 } }).expect(201);

        await request(app).get(`/api/funds/${created.body._id}`).set(as(other)).expect(404);
        await updateFund(created.body, { goal: null }, other).expect(404);
        expect((await Fund.findById(created.body._id)).goal.amount).toBe(30000);
    });
});

describe('the total', () => {
    const totalOf = async (headers = as()) => (await request(app).get('/api/funds').set(headers).expect(200)).body.total;

    it('splits into available and saved, in the default currency, and amount is their sum', async () => {
        // THB 36.5 and JPY 150 per USD; the user counts in THB
        await seedFund(user, { name: 'Card', currency: 'THB', currentBalance: 10000 });
        await seedFund(user, { name: 'Cash', currency: 'JPY', currentBalance: 30000 }); // 200 USD = 7300 THB
        await seedFund(user, { name: 'Trip', currency: 'USD', currentBalance: 100, kind: 'savings' }); // 3650 THB
        await seedFund(user, { name: 'Cushion', currency: 'JPY', currentBalance: 15000, kind: 'savings' }); // 3650 THB

        const total = await totalOf();

        expect(total).toMatchObject({ currency: 'THB', fundsCount: 4 });
        expect(total.available).toBeCloseTo(17300, 2);
        expect(total.saved).toBeCloseTo(7300, 2);
        expect(total.amount).toBeCloseTo(24600, 2);
        expect(total.amount).toBe(Math.round((total.available + total.saved) * 100) / 100);
    });

    it('the sum is exact even when each part rounds on its own', async () => {
        // 1 THB-cent balances in odd currencies make the parts and the whole round differently
        await seedFund(user, { name: 'A', currency: 'JPY', currentBalance: 1.01 });
        await seedFund(user, { name: 'B', currency: 'JPY', currentBalance: 1.01, kind: 'savings' });
        await seedFund(user, { name: 'C', currency: 'USD', currentBalance: 0.01 });
        await seedFund(user, { name: 'D', currency: 'USD', currentBalance: 0.01, kind: 'savings' });

        const total = await totalOf();

        expect(Math.round((total.available + total.saved) * 100)).toBe(Math.round(total.amount * 100));
    });

    it('leaves archived savings out of both parts', async () => {
        await seedFund(user, { name: 'Card', currency: 'THB', currentBalance: 1000 });
        const trip = await seedFund(user, { name: 'Trip', currency: 'THB', currentBalance: 5000, kind: 'savings' });

        expect(await totalOf()).toMatchObject({ amount: 6000, available: 1000, saved: 5000 });

        await request(app).post(`/api/funds/${trip._id}/archive`).set(as()).expect(200);

        expect(await totalOf()).toMatchObject({ amount: 1000, available: 1000, saved: 0, fundsCount: 1 });
    });

    it('is zero across the board with no funds, and counts only the caller\'s funds', async () => {
        await seedFund(other, { currency: 'THB', currentBalance: 999, kind: 'savings' });

        expect(await totalOf()).toEqual({ amount: 0, available: 0, saved: 0, currency: 'THB', fundsCount: 0 });
    });

    it('is the same on /api/funds/total', async () => {
        await seedFund(user, { currency: 'THB', currentBalance: 1000 });
        await seedFund(user, { name: 'Trip', currency: 'THB', currentBalance: 500, kind: 'savings' });

        const res = await request(app).get('/api/funds/total').set(as()).expect(200);

        expect(res.body).toMatchObject({ total: 1500, available: 1000, saved: 500 });
    });
});

describe('spending from savings and the bot', () => {
    it('an expense can be paid from a savings fund, and its balance moves', async () => {
        const category = await seedCategory(user);
        const savings = await seedFund(user, { name: 'Trip', currency: 'THB', currentBalance: 5000, kind: 'savings' });

        await request(app).post('/api/cost').set(as()).send({
            amount: 700, category: String(category._id), fundId: String(savings._id), date: '2026-11-01T10:00:00Z', tags: []
        }).expect(201);

        expect((await Fund.findById(savings._id)).currentBalance).toBe(4300);
    });

    it('the bot still gets its funds, now carrying kind', async () => {
        await seedFund(user, { name: 'Card', currency: 'THB' });
        await seedFund(user, { name: 'Trip', currency: 'THB', kind: 'savings' });

        const res = await request(app).get('/api/funds').set(botHeaders('1001')).expect(200);

        expect(res.body.funds.map(f => [f.name, f.kind]).sort()).toEqual([['Card', 'account'], ['Trip', 'savings']]);
        expect(res.body.total).toMatchObject({ fundsCount: 2 });
    });
});
