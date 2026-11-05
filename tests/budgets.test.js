const request = require('supertest');
const app = require('../app');
const Budget = require('../models/Budget');
const Category = require('../models/Category');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const User = require('../models/User');
const { seedUser, seedCategory, seedFund, bearer, botHeaders } = require('./helpers');

// 1 USD = 36.5 THB = 149.3 JPY
const RATES = [['THB', 36.5], ['JPY', 149.3]];
const JPY_TO_THB = 36.5 / 149.3;

// Day 10 of 30 in Bangkok: 33.33% of November has passed
const NOV_10 = '2026-11-10T05:00:00Z';

let a;
let b;
let global;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map(RATES) });

    a = { user: await seedUser({ telegramId: '1001', defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ telegramId: '2002', defaultCurrency: 'THB' }) };

    for (const party of [a, b]) {
        party.food = await seedCategory(party.user, { name: 'Food', icon: 'mdi-food' });
        party.taxi = await seedCategory(party.user, { name: 'Taxi', icon: 'mdi-taxi' });
        party.card = await seedFund(party.user, { name: 'Card', currency: 'THB', initialBalance: 100000, currentBalance: 100000 });
    }

    global = await seedCategory(null, { name: 'Transport', icon: 'mdi-bus' });

    freezeNow(NOV_10);
});

afterEach(() => {
    jest.restoreAllMocks();
});

// Everything depends on "now" only through Date.now; tokens are signed and checked at the same mocked time
const freezeNow = (iso) => jest.spyOn(Date, 'now').mockReturnValue(new Date(iso).getTime());

const seedCost = (party, overrides = {}) => Cost.create({
    amount: 100,
    currency: 'THB',
    rate: 1,
    category: party.food._id,
    date: new Date('2026-11-05T10:00:00Z'),
    user: party.user._id,
    ...overrides
});

const putBudget = (party, category, amount, headers = bearer(party.user)) =>
    request(app).put(`/api/budgets/${category._id}`).set(headers).send({ amount });

const getBudgets = (party, query = {}, headers = bearer(party.user)) =>
    request(app).get('/api/budgets').query(query).set(headers);

const itemOf = async (party, category, query) => {
    const res = await getBudgets(party, query);

    expect(res.status).toBe(200);

    return res.body.budgets.find(item => item.category.id === String(category._id));
};

describe('PUT /api/budgets/:categoryId', () => {
    it('creates a limit in the default currency and returns it for the current month', async () => {
        await seedCost(a, { amount: 600 });

        const res = await putBudget(a, a.food, 3000);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            id: expect.any(String),
            category: { id: String(a.food._id), name: 'Food', icon: 'mdi-food' },
            limit: 3000,
            currency: 'THB',
            spent: 600,
            remaining: 2400,
            percent: 20,
            state: 'on_track',
            currencyMismatch: false
        });

        const saved = await Budget.find({ user: a.user._id });

        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ amount: 3000, currency: 'THB' });
    });

    it('replaces the limit instead of adding a second one', async () => {
        const first = await putBudget(a, a.food, 3000);
        const second = await putBudget(a, a.food, 4500);

        expect(second.status).toBe(200);
        expect(second.body.id).toBe(first.body.id);
        expect(second.body.limit).toBe(4500);
        expect(await Budget.countDocuments({ user: a.user._id, category: a.food._id })).toBe(1);
    });

    it('refuses a second budget for the same user and category at the database', async () => {
        await Budget.init();
        await putBudget(a, a.food, 3000);

        await expect(Budget.create({ user: a.user._id, category: a.food._id, amount: 5, currency: 'THB' }))
            .rejects.toMatchObject({ code: 11000 });
    });

    it('takes the amount as a number or a numeric string', async () => {
        expect((await putBudget(a, a.food, '2500')).body.limit).toBe(2500);
        expect((await putBudget(a, a.food, 1234.5)).body.limit).toBe(1234.5);
    });

    it.each([[undefined], [null], [0], [-5], ['abc'], [''], [Infinity], [[100]], [{ amount: 1 }]])(
        'answers 400 for the amount %p and writes nothing',
        async (amount) => {
            const res = await putBudget(a, a.food, amount);

            expect(res.status).toBe(400);
            expect(await Budget.countDocuments()).toBe(0);
        }
    );

    it('answers 400 when there is no body at all', async () => {
        const res = await request(app).put(`/api/budgets/${a.food._id}`).set(bearer(a.user));

        expect(res.status).toBe(400);
    });

    it('answers 404 for another user\'s category and writes nothing', async () => {
        const res = await putBudget(a, b.food, 3000);

        expect(res.status).toBe(404);
        expect(await Budget.countDocuments()).toBe(0);
    });

    it('answers 404 for a category that does not exist or an id that is not one', async () => {
        const missing = await putBudget(a, { _id: '64b7f0f0f0f0f0f0f0f0f0f0' }, 3000);
        const garbage = await putBudget(a, { _id: 'not-an-id' }, 3000);

        expect(missing.status).toBe(404);
        expect(garbage.status).toBe(404);
    });

    it('allows a global category, and it is the caller\'s own limit alone', async () => {
        const res = await putBudget(a, global, 1500);

        expect(res.status).toBe(200);
        expect(res.body.category.name).toBe('Transport');
        expect(await Budget.countDocuments({ user: b.user._id })).toBe(0);
        expect(await itemOf(b, global)).toBeUndefined();
        expect(await Category.countDocuments({ _id: global._id, user: null })).toBe(1);
    });

    it('ignores a userId in the query or body: the limit is the caller\'s', async () => {
        const res = await request(app)
            .put(`/api/budgets/${a.food._id}`)
            .query({ userId: String(b.user._id) })
            .set(bearer(a.user))
            .send({ amount: 3000, userId: String(b.user._id), user: String(b.user._id) });

        expect(res.status).toBe(200);
        expect(await Budget.countDocuments({ user: a.user._id })).toBe(1);
        expect(await Budget.countDocuments({ user: b.user._id })).toBe(0);
    });

    it('requires credentials, and is not available to the bot', async () => {
        const anonymous = await request(app).put(`/api/budgets/${a.food._id}`).send({ amount: 100 });
        const bot = await putBudget(a, a.food, 100, botHeaders('1001'));

        expect(anonymous.status).toBe(401);
        expect(bot.status).toBe(403);
        expect(await Budget.countDocuments()).toBe(0);
    });
});

describe('DELETE /api/budgets/:categoryId', () => {
    it('answers 204, then 404', async () => {
        await putBudget(a, a.food, 3000);

        const first = await request(app).delete(`/api/budgets/${a.food._id}`).set(bearer(a.user));
        const second = await request(app).delete(`/api/budgets/${a.food._id}`).set(bearer(a.user));

        expect(first.status).toBe(204);
        expect(second.status).toBe(404);
        expect(await Budget.countDocuments()).toBe(0);
    });

    it('answers 404 for another user\'s budget and leaves it', async () => {
        await putBudget(b, b.food, 3000);

        const res = await request(app).delete(`/api/budgets/${b.food._id}`).set(bearer(a.user));
        const garbage = await request(app).delete('/api/budgets/not-an-id').set(bearer(a.user));

        expect(res.status).toBe(404);
        expect(garbage.status).toBe(404);
        expect(await Budget.countDocuments({ user: b.user._id })).toBe(1);
    });

    it('is not available to the bot or without credentials', async () => {
        await putBudget(a, a.food, 3000);

        const bot = await request(app).delete(`/api/budgets/${a.food._id}`).set(botHeaders('1001'));
        const anonymous = await request(app).delete(`/api/budgets/${a.food._id}`);

        expect(bot.status).toBe(403);
        expect(anonymous.status).toBe(401);
        expect(await Budget.countDocuments()).toBe(1);
    });
});

describe('GET /api/budgets', () => {
    it('describes the month and lists only the caller\'s budgets, most used first', async () => {
        await putBudget(a, a.food, 1000);
        await putBudget(a, a.taxi, 1000);
        await putBudget(b, b.food, 1000);
        await seedCost(a, { amount: 200 });
        await seedCost(a, { amount: 700, category: a.taxi._id });
        await seedCost(b, { amount: 999 });

        const res = await getBudgets(a);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            currency: 'THB',
            month: '2026-11',
            dateFrom: '2026-10-31T17:00:00.000Z',
            dateTo: '2026-11-30T17:00:00.000Z',
            daysInMonth: 30,
            elapsedDays: 10,
            pacePercent: 33.33
        });
        expect(res.body.budgets.map(item => [item.category.name, item.spent, item.percent])).toEqual([
            ['Taxi', 700, 70],
            ['Food', 200, 20]
        ]);
    });

    it('is empty for a user without limits', async () => {
        await putBudget(b, b.food, 1000);

        expect((await getBudgets(a)).body.budgets).toEqual([]);
    });

    it('is readable by the bot, for the linked user only', async () => {
        await putBudget(a, a.food, 1000);
        await putBudget(b, b.food, 5000);

        const res = await getBudgets(a, {}, botHeaders('1001'));

        expect(res.status).toBe(200);
        expect(res.body.budgets.map(item => item.limit)).toEqual([1000]);
    });

    it('answers 401 without credentials and ignores a userId', async () => {
        await putBudget(b, b.food, 5000);

        expect((await request(app).get('/api/budgets').query({ userId: String(b.user._id) })).status).toBe(401);
        expect((await getBudgets(a, { userId: String(b.user._id) })).body.budgets).toEqual([]);
    });

    it('takes a past month as finished and a future one as not begun', async () => {
        await putBudget(a, a.food, 1000);

        const past = (await getBudgets(a, { month: '2026-02' })).body;
        const future = (await getBudgets(a, { month: '2026-12' })).body;

        expect(past).toMatchObject({ month: '2026-02', daysInMonth: 28, elapsedDays: 28, pacePercent: 100 });
        expect(future).toMatchObject({ month: '2026-12', daysInMonth: 31, elapsedDays: 0, pacePercent: 0 });
    });

    it.each([['2026-13'], ['2026-00'], ['2026-1'], ['abc'], ['2026-11-01'], ['']])('answers 400 for the month %p', async (month) => {
        expect((await getBudgets(a, { month })).status).toBe(400);
    });

    it('omits a budget whose category no longer exists', async () => {
        await putBudget(a, a.food, 1000);
        await putBudget(a, a.taxi, 1000);
        await Category.deleteOne({ _id: a.taxi._id });

        expect((await getBudgets(a)).body.budgets.map(item => item.category.name)).toEqual(['Food']);
    });
});

describe('spent', () => {
    beforeEach(async () => {
        await putBudget(a, a.food, 10000);
    });

    it('counts the Bangkok month: 2026-10-31T18:00Z is November, 16:59Z is October', async () => {
        await seedCost(a, { amount: 10, date: new Date('2026-10-31T16:59:59.999Z') });
        await seedCost(a, { amount: 20, date: new Date('2026-10-31T17:00:00.000Z') });
        await seedCost(a, { amount: 40, date: new Date('2026-10-31T18:00:00Z') });
        await seedCost(a, { amount: 80, date: new Date('2026-11-30T16:59:59.999Z') });
        await seedCost(a, { amount: 160, date: new Date('2026-11-30T17:00:00.000Z') });

        expect((await itemOf(a, a.food)).spent).toBe(20 + 40 + 80);
        expect((await itemOf(a, a.food, { month: '2026-10' })).spent).toBe(10);
        expect((await itemOf(a, a.food, { month: '2026-12' })).spent).toBe(160);
    });

    it('counts every expense of the category whatever its tags, and only that category and user', async () => {
        await seedCost(a, { amount: 100, tags: ['japan-2026'] });
        await seedCost(a, { amount: 50, tags: [] });
        await seedCost(a, { amount: 999, category: a.taxi._id });
        await seedCost(b, { amount: 999 });

        expect((await itemOf(a, a.food)).spent).toBe(150);
    });

    it('counts a foreign-currency expense converted at its own rate, and an old one without currency at rate 1', async () => {
        await seedCost(a, { amount: 1000, currency: 'JPY', rate: JPY_TO_THB });
        // Saved before currency and rate existed
        await Cost.collection.insertOne({
            amount: 70,
            category: a.food._id,
            date: new Date('2026-11-06T10:00:00Z'),
            user: a.user._id
        });

        expect((await itemOf(a, a.food)).spent).toBe(Math.round(1000 * JPY_TO_THB) + 70);
    });

    it('equals the category total of /api/analytics/summary for the same month', async () => {
        await seedCost(a, { amount: 1000, currency: 'JPY', rate: JPY_TO_THB, date: new Date('2026-10-31T18:00:00Z') });
        await seedCost(a, { amount: 333.5, date: new Date('2026-11-12T10:00:00Z') });
        await seedCost(a, { amount: 12, currency: 'USD', rate: 36.5, date: new Date('2026-11-20T10:00:00Z') });
        await seedCost(a, { amount: 55, date: new Date('2026-10-31T16:00:00Z') });
        await Cost.collection.insertOne({
            amount: 70,
            category: a.food._id,
            date: new Date('2026-11-06T10:00:00Z'),
            user: a.user._id
        });
        await seedCost(a, { amount: 500, category: a.taxi._id });

        const summary = await request(app)
            .get('/api/analytics/summary')
            .query({ dateFrom: '2026-10-31T17:00:00.000Z', dateTo: '2026-11-30T17:00:00.000Z' })
            .set(bearer(a.user));
        const food = summary.body.categories.find(category => category.id === String(a.food._id));

        expect(summary.status).toBe(200);
        expect(food.total).toBeGreaterThan(0);
        expect((await itemOf(a, a.food)).spent).toBe(food.total);
    });

    it('follows an edited amount, a changed category, a moved date and a delete', async () => {
        const kept = await seedCost(a, { amount: 100 });
        const edited = await seedCost(a, { amount: 200 });

        expect((await itemOf(a, a.food)).spent).toBe(300);

        const amount = await request(app).patch(`/api/cost/${edited._id}`).set(bearer(a.user)).send({ amount: 250 });

        expect(amount.status).toBe(200);
        expect((await itemOf(a, a.food)).spent).toBe(350);

        const category = await request(app)
            .patch(`/api/cost/${edited._id}`)
            .set(bearer(a.user))
            .send({ category: String(a.taxi._id) });

        expect(category.status).toBe(200);
        expect((await itemOf(a, a.food)).spent).toBe(100);

        const date = await request(app)
            .patch(`/api/cost/${kept._id}`)
            .set(bearer(a.user))
            .send({ date: '2026-10-15T10:00:00Z' });

        expect(date.status).toBe(200);
        expect((await itemOf(a, a.food)).spent).toBe(0);
        expect((await itemOf(a, a.food, { month: '2026-10' })).spent).toBe(100);

        const removed = await request(app).delete(`/api/cost/${kept._id}`).set(bearer(a.user));

        expect(removed.status).toBe(204);
        expect((await itemOf(a, a.food, { month: '2026-10' })).spent).toBe(0);
    });
});

describe('state', () => {
    const stateFor = async (spent, now) => {
        freezeNow(now);
        await Cost.deleteMany({});
        await putBudget(a, a.food, 1000);

        if (spent > 0) {
            await seedCost(a, { amount: spent });
        }

        return itemOf(a, a.food);
    };

    it('is over, with a negative remaining, once spent exceeds the limit', async () => {
        const item = await stateFor(1340, NOV_10);

        expect(item).toMatchObject({ spent: 1340, remaining: -340, percent: 134, state: 'over' });
    });

    it('is on track up to the pace plus 10 points and ahead past it (day 10 of 30: 43.33%)', async () => {
        expect((await stateFor(0, NOV_10)).state).toBe('on_track');
        expect((await stateFor(433, NOV_10)).state).toBe('on_track');
        expect((await stateFor(434, NOV_10)).state).toBe('ahead');
    });

    it('is ahead from 80% used whatever the pace, and still not over at exactly the limit', async () => {
        // The last day: pace 100, so only the 80% rule applies
        const lastDay = '2026-11-30T05:00:00Z';

        expect((await stateFor(799, lastDay)).state).toBe('on_track');
        expect((await stateFor(800, lastDay)).state).toBe('ahead');
        expect((await stateFor(1000, lastDay)).state).toBe('ahead');
        expect((await stateFor(1001, lastDay)).state).toBe('over');
    });

    it('counts today as elapsed: day 1 is 3.33% of a 30-day month, so up to 13.33% is on track', async () => {
        const firstDay = '2026-11-01T00:30:00+07:00';

        expect((await stateFor(133, firstDay))).toMatchObject({ percent: 13.3, remaining: 867, state: 'on_track' });
        expect((await getBudgets(a)).body).toMatchObject({ elapsedDays: 1, pacePercent: 3.33 });
        expect((await stateFor(134, firstDay)).state).toBe('ahead');
        // The next day the pace is 6.67%
        expect((await stateFor(134, '2026-11-02T00:30:00+07:00')).state).toBe('on_track');
    });

    it('has no figures and no state when the limit was set in another currency than the default one', async () => {
        await putBudget(a, a.food, 1000);
        await seedCost(a, { amount: 500 });
        await User.updateOne({ _id: a.user._id }, { defaultCurrency: 'USD' });

        const item = await itemOf(a, a.food);

        expect(item).toMatchObject({
            limit: 1000,
            currency: 'THB',
            spent: null,
            remaining: null,
            percent: null,
            state: null,
            currencyMismatch: true
        });

        // Setting it again fixes it
        const again = await putBudget(a, a.food, 30);

        expect(again.body).toMatchObject({ currency: 'USD', currencyMismatch: false });
    });
});

describe('POST /api/cost', () => {
    const post = (party, body, headers = bearer(party.user)) => request(app).post('/api/cost').set(headers).send({
        amount: 100,
        category: String(party.food._id),
        fundId: String(party.card._id),
        date: '2026-11-08T10:00:00Z',
        ...body
    });

    it('returns the budget of the expense\'s category for its month, every other field unchanged', async () => {
        await putBudget(a, a.food, 1000);
        await seedCost(a, { amount: 300 });

        const res = await post(a, { comment: 'Lunch', tags: ['x'] });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            _id: expect.any(String),
            amount: 100,
            currency: 'THB',
            rate: 1,
            category: String(a.food._id),
            fund: String(a.card._id),
            comment: 'Lunch',
            tags: ['x'],
            fundAmount: 100,
            user: String(a.user._id)
        });
        expect(res.body.budget).toEqual({
            id: expect.any(String),
            category: { id: String(a.food._id), name: 'Food', icon: 'mdi-food' },
            limit: 1000,
            currency: 'THB',
            spent: 400,
            remaining: 600,
            percent: 40,
            state: 'on_track',
            currencyMismatch: false,
            month: '2026-11'
        });
    });

    it('uses the month of the expense\'s date, not the current one (a finished month: pace 100%)', async () => {
        await putBudget(a, a.food, 1000);
        await seedCost(a, { amount: 600, date: new Date('2026-10-02T10:00:00Z') });
        await seedCost(a, { amount: 5 });

        const res = await post(a, { amount: 100, date: '2026-10-20T10:00:00Z' });

        expect(res.status).toBe(201);
        expect(res.body.budget).toMatchObject({ month: '2026-10', spent: 700, remaining: 300, state: 'on_track' });
    });

    it('is null without a limit on the category, and for a global category nobody limited', async () => {
        await putBudget(a, a.taxi, 1000);

        expect((await post(a, {})).body.budget).toBeNull();
        expect((await post(a, { category: String(global._id) })).body.budget).toBeNull();
    });

    it('does not show another user\'s limit on a global category', async () => {
        await putBudget(b, global, 1000);

        const res = await post(a, { category: String(global._id) });

        expect(res.status).toBe(201);
        expect(res.body.budget).toBeNull();
    });

    it('books an expense that takes the category over its limit, and says so', async () => {
        await putBudget(a, a.food, 1000);
        await seedCost(a, { amount: 950 });

        const res = await post(a, { amount: 390 });

        expect(res.status).toBe(201);
        expect(res.body.budget).toMatchObject({ spent: 1340, remaining: -340, state: 'over' });
        expect(await Cost.countDocuments({ user: a.user._id })).toBe(2);
        expect((await request(app).get(`/api/funds/${a.card._id}`).set(bearer(a.user))).body.currentBalance).toBe(100000 - 390);
    });

    it('answers 201 with budget null, the expense saved, when the budget lookup throws', async () => {
        await putBudget(a, a.food, 1000);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(Budget, 'findOne').mockRejectedValue(new Error('database went away'));

        const res = await post(a, { amount: 123 });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ amount: 123, budget: null });
        expect(await Cost.countDocuments({ user: a.user._id, amount: 123 })).toBe(1);
    });

    it('answers 201 with budget null when computing the spent amount throws', async () => {
        await putBudget(a, a.food, 1000);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(Cost, 'aggregate').mockRejectedValue(new Error('aggregation failed'));

        const res = await post(a, { amount: 123 });

        expect(res.status).toBe(201);
        expect(res.body.budget).toBeNull();
    });

    it('gives the bot the budget too', async () => {
        await putBudget(a, a.food, 1000);

        const res = await post(a, {}, botHeaders('1001'));

        expect(res.status).toBe(201);
        expect(res.body.budget).toMatchObject({ limit: 1000, spent: 100, state: 'on_track' });
    });

    it('still refuses what it refused before: a category that is not the caller\'s is 404 and no budget work happens', async () => {
        await putBudget(b, b.food, 1000);

        const res = await post(a, { category: String(b.food._id) });

        expect(res.status).toBe(404);
        expect(res.body.budget).toBeUndefined();
    });
});
