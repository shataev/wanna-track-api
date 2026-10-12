const request = require('supertest');
const app = require('../app');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const { seedUser, seedFund, seedCategory, bearer, botHeaders } = require('./helpers');

// 1 USD = 36.5 THB = 149.3 JPY
const RATES = [['THB', 36.5], ['JPY', 149.3], ['EUR', 0.9]];
const JPY_TO_THB = 36.5 / 149.3;
// 1500 JPY debited from a THB fund, rounded to satang
const RAMEN_IN_THB = 366.71;

let a;
let b;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map(RATES) });

    a = { user: await seedUser({ telegramId: '1001', defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ telegramId: '2002', defaultCurrency: 'THB' }) };

    for (const party of [a, b]) {
        party.card = await seedFund(party.user, { name: 'Card', currency: 'THB' });
        party.cash = await seedFund(party.user, { name: 'Cash', currency: 'THB', initialBalance: 200, currentBalance: 200 });
        party.category = await seedCategory(party.user);
        party.otherCategory = await seedCategory(party.user, { name: 'Transport', icon: 'mdi-bus' });
    }
});

// A cost created the way the web and the bot create one, so the fund is really debited
const createCost = async (party, overrides = {}) => {
    const res = await request(app).post('/api/cost').set(bearer(party.user)).send({
        amount: 100,
        category: party.category._id.toString(),
        fundId: party.card._id.toString(),
        date: '2026-10-25T10:00:00Z',
        comment: 'Ramen',
        tags: [],
        ...overrides
    });

    expect(res.status).toBe(201);

    return res.body;
};

const patchCost = (party, id, body, headers = bearer(party.user)) =>
    request(app).patch(`/api/cost/${id}`).set(headers).send(body);

const deleteCost = (party, id, headers = bearer(party.user)) =>
    request(app).delete(`/api/cost/${id}`).set(headers);

const balanceOf = async (fund) => (await Fund.findById(fund._id)).currentBalance;

const historyOf = async (fund) => (await FundTransaction.find({ fundId: fund._id }).sort({ _id: 1 }))
    .map(({ type, amount, description }) => ({ type, amount, description }));

// Everything that money and the cost list are made of, to compare before and after a refused request
const snapshot = async () => ({
    funds: (await Fund.find().sort({ _id: 1 }).lean()).map(({ _id, currentBalance }) => ({ _id, currentBalance })),
    costs: await Cost.find().sort({ _id: 1 }).lean(),
    transactions: await FundTransaction.find().sort({ _id: 1 }).lean()
});

describe('DELETE /api/cost/:id', () => {
    it('credits the fund back and writes a refund', async () => {
        const cost = await createCost(a);
        expect(await balanceOf(a.card)).toBe(900);

        const res = await deleteCost(a, cost._id);

        expect(res.status).toBe(204);
        expect(await Cost.findById(cost._id)).toBeNull();
        expect(await balanceOf(a.card)).toBe(1000);
        expect(await historyOf(a.card)).toEqual([
            { type: 'expense', amount: -100, description: 'Ramen' },
            { type: 'refund', amount: 100, description: 'Deleted: Ramen' }
        ]);
    });

    it('credits a THB fund back with the converted amount of a JPY cost', async () => {
        const cost = await createCost(a, { amount: 1500, currency: 'JPY' });
        expect(cost.fundAmount).toBe(RAMEN_IN_THB);

        const res = await deleteCost(a, cost._id);

        expect(res.status).toBe(204);
        expect(await balanceOf(a.card)).toBeCloseTo(1000, 6);
        expect((await historyOf(a.card))[1]).toEqual(
            { type: 'refund', amount: RAMEN_IN_THB, description: 'Deleted: Ramen (1500 JPY)' }
        );
    });

    it('credits back `amount` for a cost saved before fundAmount existed', async () => {
        const cost = await Cost.create({
            amount: 70, currency: 'THB', rate: 1, category: a.category._id, date: new Date('2026-09-01'),
            user: a.user._id, fund: a.card._id
        });

        await deleteCost(a, cost._id);

        expect(await balanceOf(a.card)).toBe(1070);
    });

    it('names the category when the cost has no comment', async () => {
        const cost = await createCost(a, { comment: '' });

        await deleteCost(a, cost._id);

        expect((await historyOf(a.card))[1].description).toBe('Deleted: Food');
    });

    it('just deletes a cost without a fund', async () => {
        const cost = await createCost(a, { fundId: undefined });

        const res = await deleteCost(a, cost._id);

        expect(res.status).toBe(204);
        expect(await Cost.countDocuments()).toBe(0);
        expect(await FundTransaction.countDocuments()).toBe(0);
        expect(await balanceOf(a.card)).toBe(1000);
    });

    it('just deletes the cost when its fund was deleted since', async () => {
        const cost = await createCost(a);
        await request(app).delete(`/api/funds/${a.card._id}`).set(bearer(a.user)).expect(200);

        const res = await deleteCost(a, cost._id);

        expect(res.status).toBe(204);
        expect(await Cost.countDocuments()).toBe(0);
        expect(await FundTransaction.countDocuments()).toBe(0);
        expect(await Fund.findById(a.card._id)).toBeNull();
        expect(await balanceOf(a.cash)).toBe(200);
    });
});

describe('PATCH /api/cost/:id moving money', () => {
    it('debits the difference when the amount changes in the same fund, with two history lines', async () => {
        const cost = await createCost(a);

        const res = await patchCost(a, cost._id, { amount: 150 });

        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(150);
        expect(res.body.fundAmount).toBe(150);
        expect(await balanceOf(a.card)).toBe(850);
        expect(await historyOf(a.card)).toEqual([
            { type: 'expense', amount: -100, description: 'Ramen' },
            { type: 'refund', amount: 100, description: 'Edited: Ramen' },
            { type: 'expense', amount: -150, description: 'Edited: Ramen' }
        ]);
    });

    it('credits the difference when the amount goes down', async () => {
        const cost = await createCost(a);

        await patchCost(a, cost._id, { amount: '40' }).expect(200);

        expect(await balanceOf(a.card)).toBe(960);
    });

    it('counts the old debit as available when the fund stays the same', async () => {
        const cost = await createCost(a, { amount: 900 });
        expect(await balanceOf(a.card)).toBe(100);

        const res = await patchCost(a, cost._id, { amount: 1000 });

        expect(res.status).toBe(200);
        expect(await balanceOf(a.card)).toBe(0);
    });

    it('is 400 Insufficient funds when even the old debit does not cover the new amount', async () => {
        const cost = await createCost(a, { amount: 900 });
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { amount: 1000.01 });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Insufficient funds');
        expect(await snapshot()).toEqual(before);
    });

    it('credits the old fund and debits the new one when the fund changes', async () => {
        const cost = await createCost(a);

        const res = await patchCost(a, cost._id, { fundId: a.cash._id.toString(), amount: 120 });

        expect(res.status).toBe(200);
        expect(res.body.fund).toEqual({ _id: a.cash._id.toString(), name: 'Cash', currency: 'THB' });
        expect(res.body.fundAmount).toBe(120);
        expect(await balanceOf(a.card)).toBe(1000);
        expect(await balanceOf(a.cash)).toBe(80);
        expect(await historyOf(a.card)).toEqual([
            { type: 'expense', amount: -100, description: 'Ramen' },
            { type: 'refund', amount: 100, description: 'Edited: Ramen' }
        ]);
        expect(await historyOf(a.cash)).toEqual([
            { type: 'expense', amount: -120, description: 'Edited: Ramen' }
        ]);
    });

    it('does not count the old debit in a different fund: 400 and nothing changed anywhere', async () => {
        const cost = await createCost(a, { amount: 150 });
        const before = await snapshot();

        // Cash holds 200; the 150 coming back to Card does not help it pay 250
        const res = await patchCost(a, cost._id, { fundId: a.cash._id.toString(), amount: 250 });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Insufficient funds');
        expect(await snapshot()).toEqual(before);
    });

    it('credits the fund back when the cost is taken off any fund', async () => {
        const cost = await createCost(a);

        const res = await patchCost(a, cost._id, { fundId: null });

        expect(res.status).toBe(200);
        expect(res.body.fund).toBeNull();
        expect(res.body.fundAmount).toBeNull();
        expect(await balanceOf(a.card)).toBe(1000);
        expect((await historyOf(a.card)).map(t => t.type)).toEqual(['expense', 'refund']);

        const saved = await Cost.findById(cost._id).lean();
        expect(saved.fund).toBeNull();
        expect(saved).not.toHaveProperty('fundAmount');
    });

    it('debits a fund when a cost without one gets it', async () => {
        const cost = await createCost(a, { fundId: undefined });

        const res = await patchCost(a, cost._id, { fundId: a.card._id.toString() });

        expect(res.status).toBe(200);
        expect(res.body.fundAmount).toBe(100);
        expect(await balanceOf(a.card)).toBe(900);
        expect(await historyOf(a.card)).toEqual([{ type: 'expense', amount: -100, description: 'Edited: Ramen' }]);
    });

    it('is 400 when a cost without a fund gets one that cannot pay it, and nothing changes', async () => {
        const cost = await createCost(a, { fundId: undefined, amount: 300 });
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { fundId: a.cash._id.toString() });

        expect(res.status).toBe(400);
        expect(await snapshot()).toEqual(before);
    });

    it('recomputes fundAmount and rate when the currency changes', async () => {
        const cost = await createCost(a, { amount: 300 });
        expect(cost.rate).toBe(1);

        const res = await patchCost(a, cost._id, { amount: 1500, currency: 'jpy' });

        expect(res.status).toBe(200);
        expect(res.body.currency).toBe('JPY');
        expect(res.body.fundAmount).toBe(RAMEN_IN_THB);
        expect(res.body.rate).toBeCloseTo(JPY_TO_THB, 10);
        expect(await balanceOf(a.card)).toBeCloseTo(1000 - RAMEN_IN_THB, 6);
        expect((await historyOf(a.card)).slice(1)).toEqual([
            { type: 'refund', amount: 300, description: 'Edited: Ramen' },
            { type: 'expense', amount: -RAMEN_IN_THB, description: 'Edited: Ramen (1500 JPY)' }
        ]);
    });

    it('keeps the rate of the day of the expense when only the amount changes', async () => {
        const dayRate = 0.25;
        const cost = await Cost.create({
            amount: 1000, currency: 'JPY', rate: dayRate, category: a.category._id, date: new Date('2026-10-25'),
            user: a.user._id
        });

        const res = await patchCost(a, cost._id, { amount: 2000 });

        expect(res.status).toBe(200);
        expect(res.body.rate).toBe(dayRate);
    });

    it('is 400 for an unknown currency, and nothing changes', async () => {
        const cost = await createCost(a);
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { currency: 'XYZ' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Exchange rate not found for currency: XYZ');
        expect(await snapshot()).toEqual(before);
    });

    it.each([[0], [-5], ['abc'], [''], [null], [Number.NaN]])('is 400 for amount %j, and nothing changes', async (amount) => {
        const cost = await createCost(a);
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { amount });

        expect(res.status).toBe(400);
        expect(await snapshot()).toEqual(before);
    });

    it('is 404 for B\'s fund, and nothing changes for A or B', async () => {
        const cost = await createCost(a);
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { fundId: b.card._id.toString() });

        expect(res.status).toBe(404);
        expect(await snapshot()).toEqual(before);
    });

    it('is 404 for an invalid fund id, and nothing changes', async () => {
        const cost = await createCost(a);
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { fundId: 'not-an-id' });

        expect(res.status).toBe(404);
        expect(await snapshot()).toEqual(before);
    });

    it('validates the category before moving money', async () => {
        const cost = await createCost(a);
        const before = await snapshot();

        const res = await patchCost(a, cost._id, { amount: 150, category: b.category._id.toString() });

        expect(res.status).toBe(404);
        expect(await snapshot()).toEqual(before);
    });

    it('is 404 Fund not found for a change of amount on a fund deleted since; taking it off the fund works', async () => {
        const cost = await createCost(a);
        await request(app).delete(`/api/funds/${a.card._id}`).set(bearer(a.user)).expect(200);

        expect((await patchCost(a, cost._id, { amount: 150 })).status).toBe(404);

        const res = await patchCost(a, cost._id, { fundId: null, amount: 150 });

        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(150);
        expect(await FundTransaction.countDocuments()).toBe(0);
    });
});

describe('PATCH /api/cost/:id without moving money', () => {
    it('changes comment, date, category and tags and leaves the fund alone', async () => {
        const cost = await createCost(a);
        const historyBefore = await historyOf(a.card);

        const res = await patchCost(a, cost._id, {
            comment: 'Sushi',
            date: '2026-10-26T12:00:00Z',
            category: a.otherCategory._id.toString(),
            tags: ['Japan 2026']
        });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            comment: 'Sushi',
            date: '2026-10-26T12:00:00.000Z',
            category: { _id: a.otherCategory._id.toString(), name: 'Transport' },
            tags: ['japan-2026'],
            amount: 100,
            fundAmount: 100
        });
        expect(await balanceOf(a.card)).toBe(900);
        expect(await historyOf(a.card)).toEqual(historyBefore);
    });

    it('moves no money when the form sends amount, currency and fund unchanged', async () => {
        const cost = await createCost(a, { amount: 1500, currency: 'JPY' });
        const balance = await balanceOf(a.card);

        const res = await patchCost(a, cost._id, {
            amount: '1500', currency: 'JPY', fundId: a.card._id.toString(), comment: 'Ramen and gyoza'
        });

        expect(res.status).toBe(200);
        expect(res.body.fundAmount).toBe(RAMEN_IN_THB);
        expect(await balanceOf(a.card)).toBe(balance);
        expect(await FundTransaction.countDocuments()).toBe(1);
    });

    it('accepts a global category', async () => {
        const global = await seedCategory(null, { name: 'Other' });
        const cost = await createCost(a);

        const res = await patchCost(a, cost._id, { category: global._id.toString() });

        expect(res.status).toBe(200);
        expect(res.body.category.name).toBe('Other');
    });

    it('ignores fields that are not editable', async () => {
        const cost = await createCost(a);

        const res = await patchCost(a, cost._id, { user: b.user._id.toString(), fundAmount: 1, rate: 9 });

        expect(res.status).toBe(200);
        const saved = await Cost.findById(cost._id);
        expect(saved.user.toString()).toBe(a.user._id.toString());
        expect(saved.fundAmount).toBe(100);
        expect(saved.rate).toBe(1);
    });

    it.each([['an invalid date', { date: 'not a date' }], ['a null date', { date: null }], ['a non-string comment', { comment: { $ne: 1 } }]])(
        'is 400 for %s',
        async (label, body) => {
            const cost = await createCost(a);
            const before = await snapshot();

            expect((await patchCost(a, cost._id, body)).status).toBe(400);
            expect(await snapshot()).toEqual(before);
        }
    );
});

describe('GET /api/cost/:id', () => {
    it('returns the cost with category, fund, tags and fundAmount', async () => {
        const cost = await createCost(a, { amount: 1500, currency: 'JPY', tags: ['japan-2026'] });

        const res = await request(app).get(`/api/cost/${cost._id}`).set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            _id: cost._id,
            amount: 1500,
            currency: 'JPY',
            comment: 'Ramen',
            date: '2026-10-25T10:00:00.000Z',
            category: { _id: a.category._id.toString(), name: 'Food', icon: 'mdi-food' },
            fund: { _id: a.card._id.toString(), name: 'Card', currency: 'THB' },
            tags: ['japan-2026'],
            fundAmount: RAMEN_IN_THB
        });
    });

    it('has fund and fundAmount null without a fund', async () => {
        const cost = await createCost(a, { fundId: undefined });

        const res = await request(app).get(`/api/cost/${cost._id}`).set(bearer(a.user));

        expect(res.body.fund).toBeNull();
        expect(res.body.fundAmount).toBeNull();
    });
});

describe('ownership and identity', () => {
    it('is 404 for B\'s cost on GET, PATCH and DELETE, and B keeps cost and money', async () => {
        const cost = await createCost(b);
        const before = await snapshot();

        expect((await request(app).get(`/api/cost/${cost._id}`).set(bearer(a.user))).status).toBe(404);
        expect((await patchCost(a, cost._id, { amount: 1, fundId: a.card._id.toString() })).status).toBe(404);
        expect((await patchCost(a, cost._id, { comment: 'mine' })).status).toBe(404);
        expect((await deleteCost(a, cost._id)).status).toBe(404);

        expect(await snapshot()).toEqual(before);
        expect(await balanceOf(b.card)).toBe(900);
    });

    it.each([['not-an-id'], ['652f1c2e9b1d8a0012345678'], ['123']])('is 404 for id %s', async (id) => {
        expect((await request(app).get(`/api/cost/${id}`).set(bearer(a.user))).status).toBe(404);
        expect((await patchCost(a, id, { amount: 5 })).status).toBe(404);
        expect((await deleteCost(a, id)).status).toBe(404);
    });

    it('is 403 for the bot on GET, PATCH and DELETE, and nothing changes', async () => {
        const cost = await createCost(a);
        const before = await snapshot();

        expect((await request(app).get(`/api/cost/${cost._id}`).set(botHeaders('1001'))).status).toBe(403);
        expect((await patchCost(a, cost._id, { amount: 1 }, botHeaders('1001'))).status).toBe(403);
        expect((await deleteCost(a, cost._id, botHeaders('1001'))).status).toBe(403);

        expect(await snapshot()).toEqual(before);
    });
});
