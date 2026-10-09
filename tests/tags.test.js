const request = require('supertest');
const app = require('../app');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const User = require('../models/User');
const { normalizeTag, normalizeTags } = require('../utils/tag.utils');
const { seedUser, seedFund, seedCategory, bearer, botHeaders } = require('./helpers');

// 1 USD = 36.5 THB = 149.3 JPY = 25400 VND
const RATES = [['THB', 36.5], ['JPY', 149.3], ['VND', 25400], ['EUR', 0.9]];
const JPY_TO_THB = 36.5 / 149.3;

let a;
let b;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map(RATES) });

    a = { user: await seedUser({ telegramId: '1001', defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ telegramId: '2002', defaultCurrency: 'THB' }) };

    for (const party of [a, b]) {
        party.thbFund = await seedFund(party.user, { name: 'Card', currency: 'THB' });
        party.category = await seedCategory(party.user);
    }
});

const costBody = (party, overrides = {}) => ({
    amount: 100,
    category: party.category._id.toString(),
    fundId: party.thbFund._id.toString(),
    date: '2026-10-25T10:00:00Z',
    comment: 'Ramen',
    ...overrides
});

const postCost = (party, overrides, headers = bearer(party.user)) =>
    request(app).post('/api/cost').set(headers).send(costBody(party, overrides));

const setActiveTag = (user, activeTag) => User.updateOne({ _id: user._id }, { activeTag });

const balanceOf = async (fund) => (await Fund.findById(fund._id)).currentBalance;

const seedCost = (party, overrides = {}) => Cost.create({
    amount: 100,
    currency: 'THB',
    rate: 1,
    category: party.category._id,
    date: new Date('2026-10-25'),
    user: party.user._id,
    ...overrides
});

describe('tag normalisation', () => {
    it.each([
        ['  Japan 2026 ', 'japan-2026'],
        ['Поездка  В   Японию', 'поездка-в-японию'],
        ['日本', '日本'],
        ['ญี่ปุ่น', 'ญี่ปุ่น'],
        ['Tokyo!!! (day 1)', 'tokyo-day-1'],
        ['snake_case-ok', 'snake_case-ok'],
        ['a'.repeat(40), 'a'.repeat(32)],
        ['ё'.repeat(40), 'ё'.repeat(32)]
    ])('%j -> %j', (input, expected) => {
        expect(normalizeTag(input)).toBe(expected);
    });

    it.each([['!!!'], ['   '], [''], [null], [42], [['japan']]])('%j is dropped', (input) => {
        expect(normalizeTag(input)).toBeNull();
    });

    it('drops invalid tags and duplicates, keeping the first occurrence', () => {
        expect(normalizeTags(['Japan', '!!', 'food', ' JAPAN ', 'japan', 7, 'Food'])).toEqual(['japan', 'food']);
    });

    it('keeps at most 10 tags, counted after de-duplication', () => {
        const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`);

        expect(normalizeTags(eleven)).toEqual(eleven.slice(0, 10));
        expect(normalizeTags(['t0', 'T0', ...eleven])).toEqual(eleven.slice(0, 10));
    });
});

describe('POST /api/cost tags', () => {
    it('gets the active tag when tags are absent', async () => {
        await setActiveTag(a.user, 'japan-2026');

        const res = await postCost(a);

        expect(res.status).toBe(201);
        expect(res.body.tags).toEqual(['japan-2026']);
        expect((await Cost.findById(res.body._id)).tags).toEqual(['japan-2026']);
    });

    it('gets the active tag from the deployed bot, which sends no tags', async () => {
        await setActiveTag(a.user, 'japan-2026');

        const res = await postCost(a, {}, botHeaders('1001'));

        expect(res.status).toBe(201);
        expect(res.body.tags).toEqual(['japan-2026']);
    });

    it('does not get the active tag with tags: []', async () => {
        await setActiveTag(a.user, 'japan-2026');

        const res = await postCost(a, { tags: [] });

        expect(res.status).toBe(201);
        expect(res.body.tags).toEqual([]);
        expect((await Cost.findById(res.body._id)).tags).toEqual([]);
    });

    it('has no tags without an active tag', async () => {
        const res = await postCost(a);

        expect(res.body.tags).toEqual([]);
    });

    it('normalises the tags given instead of the active tag', async () => {
        await setActiveTag(a.user, 'japan-2026');
        const tags = ['Поездка в Японию', 'Food', ' food ', '!!!', ...Array.from({ length: 11 }, (_, i) => `t${i}`)];

        const res = await postCost(a, { tags });

        expect(res.status).toBe(201);
        expect(res.body.tags).toEqual(['поездка-в-японию', 'food', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
    });

    it.each([['a string', 'japan'], ['null', null], ['an object', { $ne: null }]])(
        'is 400 when tags is %s, before any money moves',
        async (label, tags) => {
            const res = await postCost(a, { tags });

            expect(res.status).toBe(400);
            expect(await balanceOf(a.thbFund)).toBe(1000);
            expect(await Cost.countDocuments()).toBe(0);
        }
    );
});

describe('POST /api/cost currency', () => {
    it('debits a JPY expense from a THB fund in baht, rounded to satang', async () => {
        const res = await postCost(a, { amount: 1500, currency: 'JPY' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ amount: 1500, currency: 'JPY', fundAmount: 366.71, tags: [] });
        expect(res.body.rate).toBeCloseTo(JPY_TO_THB, 12);
        expect(await balanceOf(a.thbFund)).toBeCloseTo(633.29, 10);

        const transaction = await FundTransaction.findOne({ fundId: a.thbFund._id });
        expect(transaction.amount).toBe(-366.71);
        expect(transaction.description).toBe('Ramen (1500 JPY)');
    });

    it('debits whole dong from a VND fund', async () => {
        const vndFund = await seedFund(a.user, { currency: 'VND', initialBalance: 1000000, currentBalance: 1000000 });

        const res = await postCost(a, { amount: 99.99, currency: 'THB', fundId: vndFund._id.toString() });

        expect(res.status).toBe(201);
        expect(res.body.fundAmount).toBe(69582);
        expect(await balanceOf(vndFund)).toBe(1000000 - 69582);
    });

    it('debits whole yen from a JPY fund', async () => {
        const jpyFund = await seedFund(a.user, { currency: 'JPY', initialBalance: 10000, currentBalance: 10000 });

        const res = await postCost(a, { amount: 500, currency: 'THB', fundId: jpyFund._id.toString() });

        expect(res.status).toBe(201);
        expect(res.body.fundAmount).toBe(2045);
        expect(res.body.rate).toBe(1);
        expect(await balanceOf(jpyFund)).toBe(10000 - 2045);
    });

    it('checks the balance against the converted amount: more yen than the baht balance is fine', async () => {
        const res = await postCost(a, { amount: 1500, currency: 'JPY' });

        expect(res.status).toBe(201);
    });

    it('checks the balance against the converted amount: 100 USD from 1000 JPY is not', async () => {
        const jpyFund = await seedFund(a.user, { currency: 'JPY', initialBalance: 1000, currentBalance: 1000 });

        const res = await postCost(a, { amount: 100, currency: 'USD', fundId: jpyFund._id.toString() });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Insufficient funds');
        expect(await balanceOf(jpyFund)).toBe(1000);
        expect(await Cost.countDocuments()).toBe(0);
        expect(await FundTransaction.countDocuments()).toBe(0);
    });

    it('is 400 when the converted amount rounds to nothing', async () => {
        const jpyFund = await seedFund(a.user, { currency: 'JPY', initialBalance: 1000, currentBalance: 1000 });

        const res = await postCost(a, { amount: 0.001, currency: 'THB', fundId: jpyFund._id.toString() });

        expect(res.status).toBe(400);
        expect(await balanceOf(jpyFund)).toBe(1000);
        expect(await Cost.countDocuments()).toBe(0);
    });

    it('same currency debits the amount itself and keeps the description', async () => {
        const res = await postCost(a, { amount: 120.5, currency: 'thb' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ currency: 'THB', fundAmount: 120.5, rate: 1 });
        expect(await balanceOf(a.thbFund)).toBe(879.5);
        expect((await FundTransaction.findOne()).description).toBe('Ramen');
    });

    it('without a currency books in the fund\'s currency, as the deployed bot expects', async () => {
        const jpyFund = await seedFund(a.user, { currency: 'JPY', initialBalance: 10000, currentBalance: 10000 });

        const res = await postCost(a, { amount: 1500, fundId: jpyFund._id.toString() });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ currency: 'JPY', fundAmount: 1500 });
        expect(res.body.rate).toBeCloseTo(JPY_TO_THB, 12);
        expect(await balanceOf(jpyFund)).toBe(8500);
    });

    it('ignores a rate in the body without a fund', async () => {
        const res = await postCost(a, { amount: 1500, currency: 'JPY', rate: 999, fundId: undefined });

        expect(res.status).toBe(201);
        expect(res.body.rate).toBeCloseTo(JPY_TO_THB, 12);
        expect(res.body.fundAmount).toBeUndefined();
        expect(res.body.fund).toBeNull();
    });

    it('ignores a rate in the body in the user\'s own currency', async () => {
        const res = await postCost(a, { rate: 5, fundId: undefined });

        expect(res.body).toMatchObject({ currency: 'THB', rate: 1 });
    });

    it('ignores a rate in the body with a fund', async () => {
        const res = await postCost(a, { amount: 1500, currency: 'JPY', rate: 1 });

        expect(res.body.fundAmount).toBe(366.71);
        expect(res.body.rate).toBeCloseTo(JPY_TO_THB, 12);
    });

    it.each([
        ['with a fund', {}],
        ['without a fund', { fundId: undefined }]
    ])('is 400 for an unknown currency %s, with nothing debited', async (label, overrides) => {
        const res = await postCost(a, { currency: 'XYZ', ...overrides });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Exchange rate not found for currency: XYZ');
        expect(await balanceOf(a.thbFund)).toBe(1000);
        expect(await Cost.countDocuments()).toBe(0);
        expect(await FundTransaction.countDocuments()).toBe(0);
    });

    it.each([['a number', 392], ['a word', 'yen'], ['an object', { $ne: null }]])(
        'is 400 when the currency is %s',
        async (label, currency) => {
            const res = await postCost(a, { currency });

            expect(res.status).toBe(400);
            expect(await balanceOf(a.thbFund)).toBe(1000);
            expect(await Cost.countDocuments()).toBe(0);
        }
    );
});

describe('PATCH /api/cost/:id', () => {
    it('replaces the tags of the caller\'s cost, normalised, and nothing else', async () => {
        const cost = await seedCost(a, { tags: ['old'], fund: a.thbFund._id, fundAmount: 100 });

        const res = await request(app).patch(`/api/cost/${cost._id}`).set(bearer(a.user))
            .send({ tags: ['Japan 2026', 'japan-2026', 'Food'], amount: 1, fundAmount: 1, user: b.user._id.toString() });

        expect(res.status).toBe(200);
        expect(res.body.tags).toEqual(['japan-2026', 'food']);

        const saved = await Cost.findById(cost._id);
        expect(saved.tags).toEqual(['japan-2026', 'food']);
        expect(saved.amount).toBe(100);
        expect(saved.fundAmount).toBe(100);
        expect(saved.user.toString()).toBe(a.user._id.toString());
    });

    it('clears the tags with []', async () => {
        const cost = await seedCost(a, { tags: ['old'] });

        const res = await request(app).patch(`/api/cost/${cost._id}`).set(bearer(a.user)).send({ tags: [] });

        expect(res.status).toBe(200);
        expect((await Cost.findById(cost._id)).tags).toEqual([]);
    });

    it('is 404 for B\'s cost and leaves it alone', async () => {
        const cost = await seedCost(b, { tags: ['b-trip'] });

        const res = await request(app).patch(`/api/cost/${cost._id}`).set(bearer(a.user)).send({ tags: ['mine'] });

        expect(res.status).toBe(404);
        expect(res.body.tags).toBeUndefined();
        expect((await Cost.findById(cost._id)).tags).toEqual(['b-trip']);
    });

    it.each([['not-an-id'], ['652f1c2e9b1d8a0012345678']])('is 404 for id %s', async (id) => {
        const res = await request(app).patch(`/api/cost/${id}`).set(bearer(a.user)).send({ tags: ['x'] });

        expect(res.status).toBe(404);
    });

    it.each([['absent', {}], ['a string', { tags: 'japan' }], ['null', { tags: null }]])(
        'is 400 when tags is %s and keeps the tags',
        async (label, body) => {
            const cost = await seedCost(a, { tags: ['old'] });

            const res = await request(app).patch(`/api/cost/${cost._id}`).set(bearer(a.user)).send(body);

            expect(res.status).toBe(400);
            expect((await Cost.findById(cost._id)).tags).toEqual(['old']);
        }
    );
});

describe('GET /api/tags', () => {
    it('lists the caller\'s tags with totals in the default currency, latest first; never B\'s', async () => {
        await seedCost(a, { amount: 1500, currency: 'JPY', rate: JPY_TO_THB, tags: ['japan-2026', 'food'], date: new Date('2026-10-26') });
        await seedCost(a, { amount: 100, tags: ['japan-2026'], date: new Date('2026-10-25') });
        await seedCost(a, { amount: 50, tags: ['bangkok'], date: new Date('2026-09-01') });
        await seedCost(a, { amount: 70 });
        await seedCost(b, { amount: 999, tags: ['japan-2026', 'b-secret'], date: new Date('2026-12-01') });

        const res = await request(app).get('/api/tags').set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            { tag: 'food', count: 1, total: 367, currency: 'THB', firstDate: '2026-10-26T00:00:00.000Z', lastDate: '2026-10-26T00:00:00.000Z' },
            { tag: 'japan-2026', count: 2, total: 467, currency: 'THB', firstDate: '2026-10-25T00:00:00.000Z', lastDate: '2026-10-26T00:00:00.000Z' },
            { tag: 'bangkok', count: 1, total: 50, currency: 'THB', firstDate: '2026-09-01T00:00:00.000Z', lastDate: '2026-09-01T00:00:00.000Z' }
        ]);
    });

    it('is empty for a user without tags', async () => {
        await seedCost(b, { tags: ['b-secret'] });

        const res = await request(app).get('/api/tags').set(bearer(a.user));

        expect(res.body).toEqual([]);
    });

    it('is open to the bot, for the Telegram user only', async () => {
        await seedCost(a, { tags: ['japan-2026'] });
        await seedCost(b, { tags: ['b-secret'] });

        const res = await request(app).get('/api/tags').set(botHeaders('1001'));

        expect(res.status).toBe(200);
        expect(res.body.map(entry => entry.tag)).toEqual(['japan-2026']);
    });
});

describe('GET /api/costs?tag=', () => {
    beforeEach(async () => {
        await seedCost(a, { amount: 1500, currency: 'JPY', rate: JPY_TO_THB, tags: ['japan-2026'], fund: a.thbFund._id, fundAmount: 366.71, date: new Date('2026-10-26') });
        await seedCost(a, { amount: 200, tags: ['japan-2026', 'food'], date: new Date('2025-01-01') });
        await seedCost(a, { amount: 70, date: new Date('2026-10-26') });
        await seedCost(b, { amount: 999, tags: ['japan-2026'], date: new Date('2026-10-26') });
    });

    const costsOf = (body) => body.flatMap(group => group.costs);

    it('lists all-time costs with the tag when no dates are given', async () => {
        const res = await request(app).get('/api/costs?tag=japan-2026').set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ category: 'Food', amount: 567, currency: 'THB' });
        expect(costsOf(res.body).map(cost => cost.amount).sort()).toEqual([1500, 200]);
    });

    it('carries tags, currency and fundAmount on every cost', async () => {
        const res = await request(app).get('/api/costs?tag=japan-2026').set(bearer(a.user));
        const byAmount = Object.fromEntries(costsOf(res.body).map(cost => [cost.amount, cost]));

        expect(byAmount[1500]).toMatchObject({ tags: ['japan-2026'], currency: 'JPY', fundAmount: 366.71 });
        expect(byAmount[200]).toMatchObject({ tags: ['japan-2026', 'food'], currency: 'THB', fundAmount: null });
    });

    it('normalises the tag in the query', async () => {
        const res = await request(app).get(`/api/costs?tag=${encodeURIComponent(' Japan 2026 ')}`).set(bearer(a.user));

        expect(costsOf(res.body)).toHaveLength(2);
    });

    it('applies a date bound when one is given with the tag', async () => {
        const res = await request(app).get('/api/costs?tag=japan-2026&dateFrom=2026-01-01').set(bearer(a.user));

        expect(costsOf(res.body).map(cost => cost.amount)).toEqual([1500]);
    });

    it('is empty for a tag that normalises to nothing', async () => {
        const res = await request(app).get('/api/costs?tag=!!!').set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('without a tag still filters by the period, and old costs read as before', async () => {
        await Cost.collection.insertOne({
            amount: 30, currency: 'THB', rate: 1, category: a.category._id, fund: a.thbFund._id,
            date: new Date('2026-10-27'), user: a.user._id
        });

        const res = await request(app).get('/api/costs?dateFrom=2026-10-01&dateTo=2026-11-01').set(bearer(a.user));

        expect(res.status).toBe(200);
        const byAmount = Object.fromEntries(costsOf(res.body).map(cost => [cost.amount, cost]));
        expect(Object.keys(byAmount).sort()).toEqual(['1500', '30', '70']);
        expect(byAmount[30]).toMatchObject({ tags: [], fundAmount: 30 });
        expect(byAmount[70]).toMatchObject({ tags: [], fundAmount: null });
        expect(res.body[0].amount).toBe(367 + 70 + 30);
    });
});

describe('the active tag', () => {
    it('PUT /api/me/active-tag normalises the tag and returns the full user', async () => {
        const res = await request(app).put('/api/me/active-tag').set(bearer(a.user)).send({ tag: ' Japan 2026 ' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: a.user._id.toString(), email: a.user.email, defaultCurrency: 'THB', activeTag: 'japan-2026' });
        expect(res.body.password).toBeUndefined();
        expect((await User.findById(a.user._id)).activeTag).toBe('japan-2026');
        expect((await User.findById(b.user._id)).activeTag).toBeNull();
    });

    it.each([['null', null], ['a tag that normalises to nothing', '!!!'], ['an empty string', '']])(
        'is cleared by %s',
        async (label, tag) => {
            await setActiveTag(a.user, 'japan-2026');

            const res = await request(app).put('/api/me/active-tag').set(bearer(a.user)).send({ tag });

            expect(res.status).toBe(200);
            expect(res.body.activeTag).toBeNull();
            expect((await User.findById(a.user._id)).activeTag).toBeNull();
        }
    );

    it.each([['absent', {}], ['a number', { tag: 2026 }], ['an array', { tag: ['japan'] }]])(
        'is 400 when the tag is %s and stays as it was',
        async (label, body) => {
            await setActiveTag(a.user, 'japan-2026');

            const res = await request(app).put('/api/me/active-tag').set(bearer(a.user)).send(body);

            expect(res.status).toBe(400);
            expect((await User.findById(a.user._id)).activeTag).toBe('japan-2026');
        }
    );

    it('the bot sets it for the Telegram user, ignoring a userId, and later costs get it', async () => {
        const res = await request(app).put('/api/me/active-tag').set(botHeaders('1001'))
            .send({ tag: 'japan-2026', userId: b.user._id.toString() });

        expect(res.status).toBe(200);
        expect(res.body.activeTag).toBe('japan-2026');
        expect((await User.findById(b.user._id)).activeTag).toBeNull();

        const cost = await postCost(a, { amount: 1500, currency: 'JPY' }, botHeaders('1001'));
        expect(cost.body.tags).toEqual(['japan-2026']);
    });

    it('GET /api/me returns the full user, to the web and to the bot', async () => {
        await setActiveTag(a.user, 'japan-2026');

        for (const headers of [bearer(a.user), botHeaders('1001')]) {
            const res = await request(app).get(`/api/me?userId=${b.user._id}`).set(headers);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                id: a.user._id.toString(),
                username: a.user.username,
                email: a.user.email,
                defaultCurrency: 'THB',
                telegramId: '1001',
                verified: false,
                activeTag: 'japan-2026'
            });
        }
    });
});

describe('CORS', () => {
    it('allows PATCH in a preflight, for the edit-tags call from the web', async () => {
        const res = await request(app).options('/api/cost/652f1c2e9b1d8a0012345678')
            .set('Origin', process.env.CLIENT_URL)
            .set('Access-Control-Request-Method', 'PATCH');

        expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    });
});
