const request = require('supertest');
const app = require('../app');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const { seedUser, seedFund, seedCategory, bearer, botHeaders } = require('./helpers');

let a;
let b;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map([['THB', 36.5]]) });

    a = { user: await seedUser({ telegramId: '1001', defaultCurrency: 'THB' }) };
    b = { user: await seedUser({ telegramId: '2002', defaultCurrency: 'THB' }) };

    for (const party of [a, b]) {
        party.card = await seedFund(party.user, { name: 'Card', currency: 'THB', isDefault: true });
        party.cash = await seedFund(party.user, { name: 'Cash', currency: 'THB', initialBalance: 200, currentBalance: 200 });
        party.category = await seedCategory(party.user);
    }
});

const as = (party) => bearer(party.user);

const archive = (fund, headers) => request(app).post(`/api/funds/${fund._id}/archive`).set(headers);
const restore = (fund, headers) => request(app).post(`/api/funds/${fund._id}/restore`).set(headers);

const spend = (party, fund, overrides = {}) => request(app).post('/api/cost').set(as(party)).send({
    amount: 100,
    category: String(party.category._id),
    fundId: String(fund._id),
    date: '2026-10-25T10:00:00Z',
    comment: 'Ramen',
    tags: [],
    ...overrides
});

const balanceOf = async (fund) => (await Fund.findById(fund._id)).currentBalance;

const names = (res) => res.body.funds.map(fund => fund.name).sort();

describe('listing and the total', () => {
    it('leaves an archived fund out of the list and of the total', async () => {
        await archive(a.cash, as(a)).expect(200);

        const res = await request(app).get('/api/funds').set(as(a)).expect(200);

        expect(names(res)).toEqual(['Card']);
        expect(res.body.total).toEqual({ amount: 1000, available: 1000, saved: 0, currency: 'THB', fundsCount: 1 });

        const total = await request(app).get('/api/funds/total').set(as(a)).expect(200);

        expect(total.body).toMatchObject({ total: 1000, fundsCount: 1 });
    });

    it('lists funds saved before the field existed as active', async () => {
        await Fund.collection.updateMany({}, { $unset: { archivedAt: '' } });

        const res = await request(app).get('/api/funds').set(as(a)).expect(200);

        expect(names(res)).toEqual(['Card', 'Cash']);
        expect(res.body.total.amount).toBe(1200);
    });

    it('?archived=true lists only the caller\'s archived funds, without a total', async () => {
        await archive(a.cash, as(a)).expect(200);
        await archive(b.card, as(b)).expect(200);

        const res = await request(app).get('/api/funds?archived=true').set(as(a)).expect(200);

        expect(names(res)).toEqual(['Cash']);
        expect(res.body.funds[0]).toMatchObject({ currentBalance: 200 });
        expect(res.body.funds[0].archivedAt).toBeTruthy();
        expect(res.body.total).toBeUndefined();
    });

    it('the bot sees no archived fund and may not ask for the archive', async () => {
        await archive(a.cash, as(a)).expect(200);

        const list = await request(app).get('/api/funds').set(botHeaders('1001')).expect(200);

        expect(names(list)).toEqual(['Card']);

        await request(app).get('/api/funds?archived=true').set(botHeaders('1001')).expect(403);
    });

    it('still opens an archived fund and its transactions', async () => {
        await spend(a, a.cash, { amount: 30 }).expect(201);
        await archive(a.cash, as(a)).expect(200);

        const fund = await request(app).get(`/api/funds/${a.cash._id}`).set(as(a)).expect(200);
        const transactions = await request(app).get(`/api/funds/${a.cash._id}/transactions`).set(as(a)).expect(200);

        expect(fund.body).toMatchObject({ name: 'Cash', currentBalance: 170 });
        expect(fund.body.archivedAt).toBeTruthy();
        expect(transactions.body.map(({ type, amount }) => [type, amount])).toEqual([['expense', -30]]);
    });
});

describe('archive and restore', () => {
    it('archives with the balance kept, returns the fund, and restores it', async () => {
        const archived = await archive(a.cash, as(a)).expect(200);

        expect(archived.body).toMatchObject({ _id: String(a.cash._id), currentBalance: 200 });
        expect(archived.body.archivedAt).toBeTruthy();

        const restored = await restore(a.cash, as(a)).expect(200);

        expect(restored.body).toMatchObject({ _id: String(a.cash._id), currentBalance: 200, archivedAt: null });

        const res = await request(app).get('/api/funds').set(as(a)).expect(200);

        expect(names(res)).toEqual(['Card', 'Cash']);
    });

    it('is idempotent, and a second archive keeps the first date', async () => {
        const first = await archive(a.cash, as(a)).expect(200);
        const second = await archive(a.cash, as(a)).expect(200);

        expect(second.body.archivedAt).toBe(first.body.archivedAt);

        await restore(a.cash, as(a)).expect(200);
        const again = await restore(a.cash, as(a)).expect(200);

        expect(again.body.archivedAt).toBeNull();
    });

    it('clears the default flag of the archived fund', async () => {
        expect((await Fund.findById(a.card._id)).isDefault).toBe(true);

        const res = await archive(a.card, as(a)).expect(200);

        expect(res.body.isDefault).toBe(false);
        expect((await Fund.findById(a.card._id)).isDefault).toBe(false);

        // Restoring does not make it the default again
        await restore(a.card, as(a)).expect(200);

        expect((await Fund.findById(a.card._id)).isDefault).toBe(false);
    });

    it('is the owner\'s only: someone else\'s or a malformed id is 404 and changes nothing', async () => {
        await archive(b.cash, as(a)).expect(404);
        await restore(b.cash, as(a)).expect(404);
        await request(app).post('/api/funds/not-an-id/archive').set(as(a)).expect(404);
        await request(app).post('/api/funds/not-an-id/restore').set(as(a)).expect(404);

        expect((await Fund.findById(b.cash._id)).archivedAt).toBeNull();

        await archive(b.cash, as(b)).expect(200);
        await restore(b.cash, as(a)).expect(404);

        expect((await Fund.findById(b.cash._id)).archivedAt).not.toBeNull();
    });

    it('needs the user: no credentials 401, the bot 403', async () => {
        await request(app).post(`/api/funds/${a.cash._id}/archive`).expect(401);
        await archive(a.cash, botHeaders('1001')).expect(403);
        await restore(a.cash, botHeaders('1001')).expect(403);

        expect((await Fund.findById(a.cash._id)).archivedAt).toBeNull();
    });
});

describe('an archived fund takes no new money', () => {
    beforeEach(async () => {
        await archive(a.cash, as(a)).expect(200);
    });

    it('POST /cost to it is 400 and nothing is written', async () => {
        const res = await spend(a, a.cash);

        expect(res.status).toBe(400);
        expect(await balanceOf(a.cash)).toBe(200);
        expect(await Cost.countDocuments({ user: a.user._id })).toBe(0);
        expect(await FundTransaction.countDocuments({ fundId: a.cash._id })).toBe(0);
    });

    it('a transfer from or to it is 400 and nothing moves', async () => {
        const transfer = (fromFundId, toFundId) =>
            request(app).post('/api/funds/transfer').set(as(a)).send({ fromFundId, toFundId, amount: 50 });

        expect((await transfer(String(a.cash._id), String(a.card._id))).status).toBe(400);
        expect((await transfer(String(a.card._id), String(a.cash._id))).status).toBe(400);

        expect(await balanceOf(a.cash)).toBe(200);
        expect(await balanceOf(a.card)).toBe(1000);
        expect(await FundTransaction.countDocuments()).toBe(0);
    });

    it('it cannot be made the default', async () => {
        const res = await request(app).put(`/api/funds/${a.cash._id}`).set(as(a)).send({
            name: 'Cash', description: '', currentBalance: 200, icon: null, isDefault: true, currency: 'THB'
        });

        expect(res.status).toBe(400);
        expect((await Fund.findById(a.cash._id)).isDefault).toBe(false);
    });

    it('an expense cannot be moved onto it', async () => {
        const cost = (await spend(a, a.card, { amount: 10 }).expect(201)).body;

        const res = await request(app).patch(`/api/cost/${cost._id}`).set(as(a)).send({ fundId: String(a.cash._id) });

        expect(res.status).toBe(400);
        expect(await balanceOf(a.card)).toBe(990);
        expect(await balanceOf(a.cash)).toBe(200);
        expect((await Cost.findById(cost._id)).fund.equals(a.card._id)).toBe(true);
    });
});

describe('expenses already on an archived fund', () => {
    let cost;

    beforeEach(async () => {
        cost = (await spend(a, a.cash, { amount: 50 }).expect(201)).body;
        await archive(a.cash, as(a)).expect(200);
    });

    it('can be edited there, the difference going through the archived fund', async () => {
        const res = await request(app).patch(`/api/cost/${cost._id}`).set(as(a)).send({ amount: 80 });

        expect(res.status).toBe(200);
        expect(await balanceOf(a.cash)).toBe(120);
    });

    it('can be deleted, and the refund goes back to the archived fund', async () => {
        await request(app).delete(`/api/cost/${cost._id}`).set(as(a)).expect(204);

        expect(await balanceOf(a.cash)).toBe(200);
        expect((await FundTransaction.find({ fundId: a.cash._id, type: 'refund' })).map(t => t.amount)).toEqual([50]);
        expect((await Fund.findById(a.cash._id)).archivedAt).not.toBeNull();
    });

    it('still name the fund in the cost list', async () => {
        const res = await request(app).get('/api/costs?dateFrom=2026-01-01&dateTo=2027-01-01').set(as(a)).expect(200);

        expect(res.body.flatMap(group => group.costs).map(item => item.fund && item.fund.name)).toEqual(['Cash']);
    });
});

describe('DELETE /api/funds/:id', () => {
    const del = (fund, headers) => request(app).delete(`/api/funds/${fund._id}`).set(headers);

    it('deletes a fund that has no history', async () => {
        await del(a.cash, as(a)).expect(200);

        expect(await Fund.findById(a.cash._id)).toBeNull();
        expect((await Fund.findById(a.card._id))).not.toBeNull();
    });

    it('answers 409 fund_has_history for a fund with a cost, and removes nothing', async () => {
        await spend(a, a.cash, { amount: 20 }).expect(201);
        const before = [await Fund.countDocuments(), await Cost.countDocuments(), await FundTransaction.countDocuments()];

        const res = await del(a.cash, as(a));

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('fund_has_history');
        expect([await Fund.countDocuments(), await Cost.countDocuments(), await FundTransaction.countDocuments()]).toEqual(before);
    });

    it('answers 409 for a fund with a transaction but no cost (a transfer)', async () => {
        await request(app).post('/api/funds/transfer').set(as(a)).send({
            fromFundId: String(a.card._id), toFundId: String(a.cash._id), amount: 10
        }).expect(200);

        const res = await del(a.cash, as(a));

        expect(res.status).toBe(409);
        expect(await FundTransaction.countDocuments({ fundId: a.cash._id })).toBe(1);
        expect(await Fund.findById(a.cash._id)).not.toBeNull();
    });

    it('answers 409 for a fund with a cost but no transaction (older data)', async () => {
        await Cost.create({
            amount: 5, currency: 'THB', rate: 1, category: a.category._id, date: new Date('2026-09-01'),
            user: a.user._id, fund: a.cash._id
        });

        expect((await del(a.cash, as(a))).status).toBe(409);
    });

    it('answers 409 for a fund whose balance was adjusted by hand', async () => {
        await request(app).put(`/api/funds/${a.cash._id}`).set(as(a)).send({
            name: 'Cash', description: '', currentBalance: 250, icon: null, isDefault: false, currency: 'THB'
        }).expect(200);

        expect((await del(a.cash, as(a))).status).toBe(409);
    });

    it('also holds for an archived fund with history', async () => {
        await spend(a, a.cash, { amount: 20 }).expect(201);
        await archive(a.cash, as(a)).expect(200);

        expect((await del(a.cash, as(a))).status).toBe(409);
        expect(await Fund.findById(a.cash._id)).not.toBeNull();
    });

    it('deletes an archived fund without history', async () => {
        await archive(a.cash, as(a)).expect(200);

        await del(a.cash, as(a)).expect(200);

        expect(await Fund.findById(a.cash._id)).toBeNull();
    });

    it('is 404 for someone else\'s fund, history or not, and a malformed id', async () => {
        await spend(b, b.cash, { amount: 20 }).expect(201);

        await del(b.cash, as(a)).expect(404);
        await del(b.card, as(a)).expect(404);
        await request(app).delete('/api/funds/not-an-id').set(as(a)).expect(404);

        expect(await Fund.countDocuments({ userId: b.user._id })).toBe(2);
    });
});
