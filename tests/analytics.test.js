const request = require('supertest');
const app = require('../app');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const { seedUser, seedFund, seedCategory, bearer, botHeaders } = require('./helpers');

// 1 USD = 36.5 THB = 149.3 JPY
const RATES = [['THB', 36.5], ['JPY', 149.3], ['EUR', 0.9]];
const JPY_TO_THB = 36.5 / 149.3;

let a;
let b;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map(RATES) });

    a = { user: await seedUser({ telegramId: '1001', defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ telegramId: '2002', defaultCurrency: 'THB' }) };

    for (const party of [a, b]) {
        party.card = await seedFund(party.user, { name: 'Card', currency: 'THB', initialBalance: 100000, currentBalance: 100000 });
        party.food = await seedCategory(party.user, { name: 'Food', icon: 'mdi-food' });
        party.taxi = await seedCategory(party.user, { name: 'Taxi', icon: 'mdi-taxi' });
    }
});

afterEach(() => {
    jest.restoreAllMocks();
});

// Analytics depends on "now" only through Date.now; the token is signed and checked at the same mocked time
const freezeNow = (iso) => jest.spyOn(Date, 'now').mockReturnValue(new Date(iso).getTime());

const seedCost = (party, overrides = {}) => Cost.create({
    amount: 100,
    currency: 'THB',
    rate: 1,
    category: party.food._id,
    date: new Date('2026-10-05T10:00:00Z'),
    user: party.user._id,
    ...overrides
});

const summary = (party, dateFrom, dateTo, headers = bearer(party.user)) =>
    request(app).get('/api/analytics/summary').query({ dateFrom, dateTo }).set(headers);

const monthly = (party, query = {}, headers = bearer(party.user)) =>
    request(app).get('/api/analytics/monthly').query(query).set(headers);

// A 10-day period whose previous period is 2026-09-21 .. 2026-10-01
const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-10-11T00:00:00.000Z';

describe('GET /api/analytics/summary', () => {
    it('counts only the caller\'s costs, whatever userId is sent', async () => {
        await seedCost(a, { amount: 100 });
        await seedCost(b, { amount: 7000, category: b.taxi._id, tags: ['japan'], fund: b.card._id });
        await seedCost(b, { amount: 900, date: new Date('2026-09-25T10:00:00Z') });

        const res = await request(app)
            .get('/api/analytics/summary')
            .query({ dateFrom: FROM, dateTo: TO, userId: b.user._id.toString() })
            .set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(100);
        expect(res.body.count).toBe(1);
        expect(res.body.previous).toMatchObject({ total: 0, count: 0 });
        expect(res.body.categories.map(category => category.name)).toEqual(['Food']);
        expect(res.body.categories[0].id).toBe(a.food._id.toString());
        expect(res.body.tags).toEqual([]);
        expect(res.body.funds).toEqual([{ id: null, name: 'No account', currency: null, total: 100, count: 1 }]);
        expect(res.body.top).toHaveLength(1);
    });

    it('splits the period from the same number of days right before it, at exact boundaries', async () => {
        await seedCost(a, { amount: 1, date: new Date('2026-09-20T23:59:59.999Z') });
        await seedCost(a, { amount: 10, date: new Date('2026-09-21T00:00:00.000Z') });
        await seedCost(a, { amount: 20, date: new Date('2026-09-30T23:59:59.999Z') });
        await seedCost(a, { amount: 100, date: new Date('2026-10-01T00:00:00.000Z') });
        await seedCost(a, { amount: 200, date: new Date('2026-10-10T23:59:59.999Z') });
        await seedCost(a, { amount: 1000, date: new Date('2026-10-11T00:00:00.000Z') });

        const res = await summary(a, FROM, TO);

        expect(res.status).toBe(200);
        expect(res.body.period).toEqual({ dateFrom: FROM, dateTo: TO, days: 10 });
        expect(res.body.total).toBe(300);
        expect(res.body.count).toBe(2);
        expect(res.body.avgPerDay).toBe(30);
        expect(res.body.previous).toEqual({
            dateFrom: '2026-09-21T00:00:00.000Z',
            dateTo: FROM,
            total: 30,
            count: 2
        });
    });

    it('reads a month as the web sends it, ending on its last millisecond, as 31 days', async () => {
        const res = await summary(a, '2026-09-30T17:00:00.000Z', '2026-10-31T16:59:59.999Z');

        expect(res.status).toBe(200);
        expect(res.body.period.days).toBe(31);
    });

    // Bangkok month starts: [label, dateFrom, next month start, previous month start]
    const CALENDAR_MONTHS = [
        ['October vs September (30 days)', '2026-09-30T17:00:00.000Z', '2026-10-31T17:00:00.000Z', '2026-08-31T17:00:00.000Z'],
        ['March vs February', '2026-02-28T17:00:00.000Z', '2026-03-31T17:00:00.000Z', '2026-01-31T17:00:00.000Z'],
        ['January vs December', '2025-12-31T17:00:00.000Z', '2026-01-31T17:00:00.000Z', '2025-11-30T17:00:00.000Z']
    ];

    describe.each(CALENDAR_MONTHS)('a Bangkok calendar month: %s', (label, from, nextFrom, previousFrom) => {
        it.each([
            ['the next month\'s start', nextFrom],
            ['its last millisecond, as the web sends it', new Date(new Date(nextFrom).getTime() - 1).toISOString()]
        ])('is compared with the previous calendar month when it ends at %s', async (_, to) => {
            await seedCost(a, { amount: 1, date: new Date(new Date(previousFrom).getTime() - 1) });
            await seedCost(a, { amount: 10, date: new Date(previousFrom) });
            await seedCost(a, { amount: 20, date: new Date(new Date(from).getTime() - 1) });
            await seedCost(a, { amount: 100, date: new Date(from) });

            const res = await summary(a, from, to);

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(100);
            expect(res.body.previous).toEqual({ dateFrom: previousFrom, dateTo: from, total: 30, count: 2 });
        });
    });

    it.each([
        ['a UTC month, not a Bangkok one', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z'],
        ['a month that starts mid-month', '2026-09-15T17:00:00.000Z', '2026-10-15T17:00:00.000Z', '2026-08-16T17:00:00.000Z'],
        ['two calendar months', '2026-08-31T17:00:00.000Z', '2026-10-31T17:00:00.000Z', '2026-07-01T17:00:00.000Z'],
        ['a month cut short by a day', '2026-09-30T17:00:00.000Z', '2026-10-30T17:00:00.000Z', '2026-08-31T17:00:00.000Z']
    ])('keeps the same number of days before %s', async (_, from, to, previousFrom) => {
        const res = await summary(a, from, to);

        expect(res.status).toBe(200);
        expect(res.body.previous.dateFrom).toBe(previousFrom);
        expect(res.body.previous.dateTo).toBe(from);
    });

    it('projects the total to the end of the period at the pace so far while today is inside it', async () => {
        freezeNow('2026-10-05T12:00:00Z');
        await seedCost(a, { amount: 300, date: new Date('2026-10-02T10:00:00Z') });
        await seedCost(a, { amount: 200, date: new Date('2026-10-05T09:00:00Z') });

        const res = await summary(a, FROM, TO);

        // 500 over 5 started days (Oct 1-5), carried to 10 days
        expect(res.body.projection).toBe(1000);
    });

    it('counts the first day as a whole day for the projection', async () => {
        freezeNow('2026-10-01T00:00:00Z');
        await seedCost(a, { amount: 50, date: new Date(FROM) });

        const res = await summary(a, FROM, TO);

        expect(res.body.projection).toBe(500);
    });

    it.each([
        ['after the period', '2026-10-11T00:00:00Z'],
        ['before the period', '2026-09-30T23:59:59Z']
    ])('has no projection when today is %s', async (_, now) => {
        freezeNow(now);
        await seedCost(a, { amount: 300 });

        const res = await summary(a, FROM, TO);

        expect(res.body.total).toBe(300);
        expect(res.body.projection).toBeNull();
    });

    it('answers an empty period with zeros and empty lists', async () => {
        freezeNow('2026-10-05T12:00:00Z');

        const res = await summary(a, FROM, TO);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            currency: 'THB',
            period: { dateFrom: FROM, dateTo: TO, days: 10 },
            total: 0,
            count: 0,
            avgPerDay: 0,
            projection: 0,
            previous: { dateFrom: '2026-09-21T00:00:00.000Z', dateTo: FROM, total: 0, count: 0 },
            categories: [],
            funds: [],
            tags: [],
            top: []
        });
    });

    it('reads an old cost without currency and rate as the default currency at rate 1', async () => {
        await Cost.collection.insertOne({
            amount: 250,
            category: a.food._id,
            date: new Date('2026-10-03T10:00:00Z'),
            user: a.user._id
        });

        const res = await summary(a, FROM, TO);

        expect(res.body.total).toBe(250);
        expect(res.body.top[0]).toMatchObject({ amount: 250, currency: 'THB', amountInUserCurrency: 250, tags: [], fund: null });
    });

    it('converts a JPY cost into the user\'s currency and keeps the original in the top list', async () => {
        const posted = await request(app).post('/api/cost').set(bearer(a.user)).send({
            amount: 1500,
            currency: 'JPY',
            category: a.food._id.toString(),
            fundId: a.card._id.toString(),
            date: '2026-10-04T10:00:00Z',
            comment: 'Ramen',
            tags: ['japan-2026']
        });
        expect(posted.status).toBe(201);

        const res = await summary(a, FROM, TO);
        const expected = Math.round(1500 * JPY_TO_THB);

        expect(expected).toBe(367);
        expect(res.body.total).toBe(expected);
        expect(res.body.top).toEqual([{
            id: posted.body._id,
            date: '2026-10-04T10:00:00.000Z',
            category: { id: a.food._id.toString(), name: 'Food', icon: 'mdi-food' },
            comment: 'Ramen',
            amount: 1500,
            currency: 'JPY',
            amountInUserCurrency: expected,
            fund: { id: a.card._id.toString(), name: 'Card' },
            tags: ['japan-2026']
        }]);
        expect(res.body.funds).toEqual([{ id: a.card._id.toString(), name: 'Card', currency: 'THB', total: expected, count: 1 }]);
    });

    it('shows a category spent on only in the previous period with 0 now, and one only now with 0 before', async () => {
        await seedCost(a, { amount: 400, category: a.taxi._id, date: new Date('2026-09-25T10:00:00Z') });
        await seedCost(a, { amount: 100, category: a.food._id, date: new Date('2026-09-26T10:00:00Z') });
        await seedCost(a, { amount: 300, category: a.food._id });

        const res = await summary(a, FROM, TO);

        expect(res.body.categories).toEqual([
            { id: a.food._id.toString(), name: 'Food', icon: 'mdi-food', total: 300, count: 1, share: 1, previousTotal: 100 },
            { id: a.taxi._id.toString(), name: 'Taxi', icon: 'mdi-taxi', total: 0, count: 0, share: 0, previousTotal: 400 }
        ]);
        expect(res.body.previous.total).toBe(500);
    });

    it('sorts categories by total with their share of it', async () => {
        await seedCost(a, { amount: 100, category: a.food._id });
        await seedCost(a, { amount: 200, category: a.taxi._id });

        const res = await summary(a, FROM, TO);

        expect(res.body.categories.map(({ name, total, share, previousTotal }) => ({ name, total, share, previousTotal }))).toEqual([
            { name: 'Taxi', total: 200, share: 0.6667, previousTotal: 0 },
            { name: 'Food', total: 100, share: 0.3333, previousTotal: 0 }
        ]);
    });

    it('totals per fund, costs without one as "No account", and per tag, leaving untagged out', async () => {
        await seedCost(a, { amount: 100, fund: a.card._id, tags: ['japan', 'food'] });
        await seedCost(a, { amount: 50, fund: a.card._id, tags: ['japan'] });
        await seedCost(a, { amount: 500 });

        const res = await summary(a, FROM, TO);

        expect(res.body.funds).toEqual([
            { id: null, name: 'No account', currency: null, total: 500, count: 1 },
            { id: a.card._id.toString(), name: 'Card', currency: 'THB', total: 150, count: 2 }
        ]);
        expect(res.body.tags).toEqual([
            { tag: 'japan', total: 150, count: 2 },
            { tag: 'food', total: 100, count: 1 }
        ]);
    });

    it('lists the 10 largest expenses of the period, largest first', async () => {
        for (let i = 1; i <= 12; i += 1) {
            await seedCost(a, { amount: i * 10, comment: `c${i}` });
        }
        await seedCost(a, { amount: 9999, date: new Date('2026-09-25T10:00:00Z') });

        const res = await summary(a, FROM, TO);

        expect(res.body.top.map(cost => cost.amountInUserCurrency)).toEqual([120, 110, 100, 90, 80, 70, 60, 50, 40, 30]);
        expect(res.body.top[0].comment).toBe('c12');
    });

    it('agrees with GET /api/costs for the same period, category by category', async () => {
        // Rates chosen so that rounding per cost and rounding a sum would differ
        await seedCost(a, { amount: 10.4, currency: 'USD', rate: 1.4, category: a.food._id });
        await seedCost(a, { amount: 3.3, currency: 'EUR', rate: 40.55, category: a.food._id });
        await seedCost(a, { amount: 1500, currency: 'JPY', rate: JPY_TO_THB, category: a.taxi._id });
        await seedCost(a, { amount: 99.5, category: a.taxi._id });
        await Cost.collection.insertOne({ amount: 12.5, category: a.taxi._id, date: new Date('2026-10-02T00:00:00Z'), user: a.user._id });

        const [analytics, costs] = await Promise.all([
            summary(a, FROM, TO),
            request(app).get('/api/costs').query({ dateFrom: FROM, dateTo: TO }).set(bearer(a.user))
        ]);

        expect(costs.status).toBe(200);
        expect(analytics.body.total).toBe(costs.body.reduce((total, group) => total + group.amount, 0));
        expect(analytics.body.count).toBe(costs.body.reduce((count, group) => count + group.costs.length, 0));
        expect(analytics.body.categories.map(({ id, total }) => ({ id, total })))
            .toEqual(costs.body.map(group => ({ id: group._id, total: group.amount })));
        expect(analytics.body.currency).toBe(costs.body[0].currency);
    });

    it.each([
        ['no dates', {}],
        ['no dateTo', { dateFrom: FROM }],
        ['no dateFrom', { dateTo: TO }],
        ['an invalid dateFrom', { dateFrom: 'yesterday', dateTo: TO }],
        ['an invalid dateTo', { dateFrom: FROM, dateTo: '2026-13-45' }],
        ['dateTo before dateFrom', { dateFrom: TO, dateTo: FROM }],
        ['an empty period', { dateFrom: FROM, dateTo: FROM }],
        ['more than 400 days', { dateFrom: '2025-01-01T00:00:00Z', dateTo: '2026-02-05T00:00:01Z' }]
    ])('is 400 with %s', async (_, query) => {
        const res = await request(app).get('/api/analytics/summary').query(query).set(bearer(a.user));

        expect(res.status).toBe(400);
    });

    it('accepts exactly 400 days', async () => {
        const res = await summary(a, '2025-01-01T00:00:00Z', '2026-02-05T00:00:00Z');

        expect(res.status).toBe(200);
        expect(res.body.period.days).toBe(400);
    });

    it('is 403 for the bot', async () => {
        await seedCost(a);

        const res = await summary(a, FROM, TO, botHeaders('1001'));

        expect(res.status).toBe(403);
        expect(res.body.total).toBeUndefined();
    });
});

describe('GET /api/analytics/monthly', () => {
    it('returns the last 12 Bangkok months by default, oldest first, empty months at 0', async () => {
        freezeNow('2026-10-15T10:00:00Z');
        await seedCost(a, { amount: 100, date: new Date('2026-10-02T10:00:00Z') });
        await seedCost(a, { amount: 40, category: a.taxi._id, date: new Date('2026-10-03T10:00:00Z') });
        await seedCost(a, { amount: 70, date: new Date('2026-08-10T10:00:00Z') });

        const res = await monthly(a);

        expect(res.status).toBe(200);
        expect(res.body.currency).toBe('THB');
        expect(res.body.months.map(month => month.month)).toEqual([
            '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
            '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'
        ]);
        expect(res.body.months[11]).toEqual({
            month: '2026-10',
            total: 140,
            categories: [
                { id: a.food._id.toString(), name: 'Food', icon: 'mdi-food', total: 100 },
                { id: a.taxi._id.toString(), name: 'Taxi', icon: 'mdi-taxi', total: 40 }
            ]
        });
        expect(res.body.months[10]).toEqual({ month: '2026-09', total: 0, categories: [] });
        expect(res.body.months[9].total).toBe(70);
    });

    it('puts an expense at 2026-09-30T18:00Z into October, as it is in Bangkok', async () => {
        freezeNow('2026-10-15T10:00:00Z');
        await seedCost(a, { amount: 5, date: new Date('2026-09-30T16:59:59.999Z') });
        await seedCost(a, { amount: 30, date: new Date('2026-09-30T18:00:00Z') });

        const res = await monthly(a, { months: 2 });

        expect(res.body.months).toEqual([
            { month: '2026-09', total: 5, categories: [expect.objectContaining({ total: 5 })] },
            { month: '2026-10', total: 30, categories: [expect.objectContaining({ total: 30 })] }
        ]);
    });

    it('takes the current month in Bangkok, which starts 7 hours before UTC\'s', async () => {
        // 2026-10-31T18:00Z is already November in Bangkok
        freezeNow('2026-10-31T18:00:00Z');
        await seedCost(a, { amount: 30, date: new Date('2026-10-31T17:30:00Z') });
        await seedCost(a, { amount: 8, date: new Date('2026-08-31T16:59:59.999Z') });

        const res = await monthly(a, { months: 3 });

        expect(res.body.months.map(({ month, total }) => ({ month, total }))).toEqual([
            { month: '2026-09', total: 0 },
            { month: '2026-10', total: 0 },
            { month: '2026-11', total: 30 }
        ]);
    });

    it('converts like GET /api/costs and never counts B\'s costs', async () => {
        freezeNow('2026-10-15T10:00:00Z');
        await seedCost(a, { amount: 1500, currency: 'JPY', rate: JPY_TO_THB });
        await Cost.collection.insertOne({ amount: 12.4, category: a.food._id, date: new Date('2026-10-02T00:00:00Z'), user: a.user._id });
        await seedCost(b, { amount: 9000 });

        const res = await monthly(a, { months: 1, userId: b.user._id.toString() });

        expect(res.body.months).toEqual([{
            month: '2026-10',
            total: 367 + 12,
            categories: [{ id: a.food._id.toString(), name: 'Food', icon: 'mdi-food', total: 379 }]
        }]);
    });

    it('crosses a year boundary with 24 months', async () => {
        freezeNow('2026-01-10T00:00:00Z');

        const res = await monthly(a, { months: 24 });

        expect(res.body.months).toHaveLength(24);
        expect(res.body.months[0].month).toBe('2024-02');
        expect(res.body.months[23].month).toBe('2026-01');
    });

    it.each([['0'], ['25'], ['abc'], ['1.5'], ['-3'], ['']])('is 400 with months=%j', async (months) => {
        const res = await monthly(a, { months });

        expect(res.status).toBe(400);
    });

    it('is 400 with months given twice', async () => {
        const res = await request(app).get('/api/analytics/monthly?months=2&months=3').set(bearer(a.user));

        expect(res.status).toBe(400);
    });

    it('is 403 for the bot', async () => {
        const res = await monthly(a, {}, botHeaders('1001'));

        expect(res.status).toBe(403);
    });
});
