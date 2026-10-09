const request = require('supertest');
const app = require('../app');
const Category = require('../models/Category');
const Cost = require('../models/Cost');
const ExchangeRate = require('../models/ExchangeRate');
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const TelegramBindingToken = require('../models/TelegramBindingToken');
const User = require('../models/User');
const {
    seedUser, seedFund, seedCategory, bearer, expiredTokenFor, cookieFor, botHeaders
} = require('./helpers');

let a;
let b;

beforeEach(async () => {
    await ExchangeRate.create({ base: 'USD', rates: new Map([['THB', 36], ['EUR', 0.9]]) });

    a = { user: await seedUser({ telegramId: '1001' }) };
    b = { user: await seedUser({ telegramId: '2002' }) };

    for (const party of [a, b]) {
        party.fund = await seedFund(party.user);
        party.otherFund = await seedFund(party.user, { name: 'Savings' });
        party.category = await seedCategory(party.user);
        party.transaction = await FundTransaction.create({
            userId: party.user._id, fundId: party.fund._id, type: 'income', amount: 1000
        });
    }
});

afterEach(() => {
    jest.restoreAllMocks();
});

const costBody = (party, overrides = {}) => ({
    amount: 10,
    category: party.category._id.toString(),
    fundId: party.fund._id.toString(),
    date: '2026-10-01T10:00:00Z',
    comment: 'lunch',
    ...overrides
});

// Every route that needs an identity, with a request that would succeed for A
const ROUTES = [
    { name: 'GET /api/costs', method: 'get', path: () => '/api/costs?dateFrom=2026-01-01&dateTo=2027-01-01', bot: false },
    { name: 'POST /api/cost', method: 'post', path: () => '/api/cost', body: () => costBody(a), bot: true },
    { name: 'GET /api/category', method: 'get', path: () => '/api/category', bot: true },
    { name: 'POST /api/category', method: 'post', path: () => '/api/category', body: () => ({ name: 'Taxi', icon: 'mdi-taxi' }), bot: false },
    { name: 'GET /api/funds', method: 'get', path: () => '/api/funds', bot: true },
    { name: 'POST /api/funds', method: 'post', path: () => '/api/funds', body: () => ({ name: 'Cash', initialBalance: 5, currency: 'USD' }), bot: false },
    { name: 'GET /api/funds/total', method: 'get', path: () => '/api/funds/total', bot: false },
    {
        name: 'POST /api/funds/transfer', method: 'post', path: () => '/api/funds/transfer', bot: false,
        body: () => ({ fromFundId: a.fund._id.toString(), toFundId: a.otherFund._id.toString(), amount: 5 })
    },
    { name: 'GET /api/funds/:id', method: 'get', path: () => `/api/funds/${a.fund._id}`, bot: false },
    { name: 'PUT /api/funds/:id', method: 'put', path: () => `/api/funds/${a.fund._id}`, body: () => ({ name: 'Renamed', currentBalance: 1000 }), bot: false },
    { name: 'DELETE /api/funds/:id', method: 'delete', path: () => `/api/funds/${a.fund._id}`, bot: false },
    { name: 'GET /api/funds/:id/transactions', method: 'get', path: () => `/api/funds/${a.fund._id}/transactions`, bot: false },
    { name: 'GET /api/telegram/telegram-binding-link', method: 'get', path: () => '/api/telegram/telegram-binding-link', bot: false },
    { name: 'POST /api/telegram/telegram-unbind', method: 'post', path: () => '/api/telegram/telegram-unbind', bot: false }
];

const send = (route, { headers = {}, userId, body } = {}) => {
    let path = route.path();
    let payload = body ?? (route.body ? route.body() : undefined);

    if (userId) {
        if (route.method === 'get') {
            path += `${path.includes('?') ? '&' : '?'}userId=${userId}`;
        } else {
            payload = { ...(payload || {}), userId };
        }
    }

    let req = request(app)[route.method](path).set(headers);

    if (payload !== undefined) {
        req = req.send(payload);
    }

    return req;
};

const expectNothingWritten = async () => {
    const [fundA, fundB] = await Promise.all([Fund.findById(a.fund._id), Fund.findById(b.fund._id)]);

    expect(fundA.currentBalance).toBe(1000);
    expect(fundA.name).toBe('Wallet');
    expect(fundB.currentBalance).toBe(1000);
    expect(fundB.name).toBe('Wallet');
    expect(await Cost.countDocuments()).toBe(0);
    expect(await Category.countDocuments()).toBe(2);
    expect(await Fund.countDocuments()).toBe(4);
    expect(await TelegramBindingToken.countDocuments()).toBe(0);
    expect((await User.findById(a.user._id)).telegramId).toBe('1001');
};

describe.each(ROUTES)('$name', (route) => {
    describe.each([['legacy mode', undefined], ['AUTH_ENFORCE=true', 'true']])('in %s', (mode, enforce) => {
        beforeEach(() => {
            if (enforce) {
                process.env.AUTH_ENFORCE = enforce;
            }
        });

        it('is 401 without credentials', async () => {
            const res = await send(route);

            expect(res.status).toBe(401);
            await expectNothingWritten();
        });

        it('is 401 with only a userId', async () => {
            const res = await send(route, { userId: a.user._id.toString() });

            expect(res.status).toBe(401);
            await expectNothingWritten();
        });

        it('is 401 with a garbage bearer', async () => {
            const res = await send(route, { headers: { Authorization: 'Bearer not.a.jwt' } });

            expect(res.status).toBe(401);
            await expectNothingWritten();
        });

        it('is 401 with an expired bearer, even next to a valid cookie', async () => {
            const res = await send(route, {
                headers: { Authorization: `Bearer ${expiredTokenFor(a.user)}`, Cookie: cookieFor(a.user) }
            });

            expect(res.status).toBe(401);
            await expectNothingWritten();
        });

        it('is 400 with a bearer and bot credentials together', async () => {
            const res = await send(route, { headers: { ...bearer(a.user), ...botHeaders('1001') } });

            expect(res.status).toBe(400);
            await expectNothingWritten();
        });
    });

    it('works with A\'s bearer', async () => {
        const res = await send(route, { headers: bearer(a.user) });

        expect(res.status).toBeLessThan(300);
    });

    it('works with A\'s cookie in legacy mode and logs it', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await send(route, { headers: { Cookie: cookieFor(a.user) } });

        expect(res.status).toBeLessThan(300);
        expect(warn).toHaveBeenCalledWith('[auth-legacy]', 'web', route.method.toUpperCase(), expect.stringMatching(/^\/api\//));
    });

    it('is 401 with A\'s cookie under AUTH_ENFORCE=true', async () => {
        process.env.AUTH_ENFORCE = 'true';

        const res = await send(route, { headers: { Cookie: cookieFor(a.user) } });

        expect(res.status).toBe(401);
        await expectNothingWritten();
    });

    if (route.bot) {
        it('works for the bot with A\'s Telegram id', async () => {
            const res = await send(route, { headers: botHeaders('1001') });

            expect(res.status).toBeLessThan(300);
        });

        it('works for the legacy bot with a userId', async () => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});

            const res = await send(route, { headers: botHeaders(), userId: a.user._id.toString() });

            expect(res.status).toBeLessThan(300);
        });
    } else {
        it('is 403 for the bot with A\'s Telegram id', async () => {
            const res = await send(route, { headers: botHeaders('1001') });

            expect(res.status).toBe(403);
            await expectNothingWritten();
        });

        it('is 403 for the legacy bot with a userId', async () => {
            jest.spyOn(console, 'warn').mockImplementation(() => {});

            const res = await send(route, { headers: botHeaders(), userId: a.user._id.toString() });

            expect(res.status).toBe(403);
            await expectNothingWritten();
        });
    }

    it('is 401 for the legacy bot under AUTH_ENFORCE=true', async () => {
        process.env.AUTH_ENFORCE = 'true';

        const res = await send(route, { headers: botHeaders(), userId: a.user._id.toString() });

        expect(res.status).toBe(401);
        await expectNothingWritten();
    });

    it('is 401 for the bot with an unlinked Telegram id', async () => {
        const res = await send(route, { headers: botHeaders('999999') });

        expect(res.status).toBe(401);
        await expectNothingWritten();
    });

    it('is 403 for the bot with a wrong secret', async () => {
        const res = await send(route, { headers: botHeaders('1001', 'test-bot-secreT') });

        expect(res.status).toBe(403);
        await expectNothingWritten();
    });
});

describe('a userId in the request is ignored', () => {
    it('GET /api/funds lists only A\'s funds', async () => {
        const res = await request(app).get(`/api/funds?userId=${b.user._id}`).set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body.funds.map(fund => fund._id).sort())
            .toEqual([a.fund._id.toString(), a.otherFund._id.toString()].sort());
    });

    it('GET /api/category lists A\'s and global categories only', async () => {
        const global = await seedCategory(null, { name: 'Global' });

        const res = await request(app).get(`/api/category?userId=${b.user._id}`).set(bearer(a.user));

        expect(res.body.map(category => category.value).sort())
            .toEqual([a.category._id.toString(), global._id.toString()].sort());
    });

    it('GET /api/costs lists only A\'s costs', async () => {
        await Cost.create({ amount: 1, currency: 'USD', rate: 1, category: b.category._id, date: new Date('2026-10-01'), user: b.user._id });
        await Cost.create({ amount: 2, currency: 'USD', rate: 1, category: a.category._id, date: new Date('2026-10-01'), user: a.user._id });

        const res = await request(app)
            .get(`/api/costs?dateFrom=2026-01-01&dateTo=2027-01-01&userId=${b.user._id}`)
            .set(bearer(a.user));

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].costs.map(cost => cost.amount)).toEqual([2]);
    });

    it('POST /api/cost saves the cost for A', async () => {
        const res = await request(app).post('/api/cost').set(bearer(a.user))
            .send(costBody(a, { userId: b.user._id.toString() }));

        expect(res.status).toBe(201);
        expect(res.body.user).toBe(a.user._id.toString());
        expect((await FundTransaction.findOne({ type: 'expense' })).userId.toString()).toBe(a.user._id.toString());
    });

    it('POST /api/category saves the category for A, never as global', async () => {
        const res = await request(app).post('/api/category').set(bearer(a.user))
            .send({ name: 'Taxi', icon: 'mdi-taxi', userId: b.user._id.toString() });

        expect(res.status).toBe(201);
        expect((await Category.findById(res.body._id)).user.toString()).toBe(a.user._id.toString());
    });

    it('POST /api/category without a userId is not global either', async () => {
        const res = await request(app).post('/api/category').set(bearer(a.user)).send({ name: 'Taxi', icon: 'mdi-taxi' });

        expect((await Category.findById(res.body._id)).user.toString()).toBe(a.user._id.toString());
    });

    it('POST /api/funds saves the fund for A', async () => {
        const res = await request(app).post('/api/funds').set(bearer(a.user))
            .send({ name: 'Cash', initialBalance: 5, currency: 'USD', userId: b.user._id.toString() });

        expect(res.status).toBe(201);
        expect(res.body.userId).toBe(a.user._id.toString());
    });

    it('GET /api/telegram/telegram-binding-link mints a token for A', async () => {
        const res = await request(app).get(`/api/telegram/telegram-binding-link?userId=${b.user._id}`).set(bearer(a.user));

        expect(res.status).toBe(200);
        const token = await TelegramBindingToken.findOne();
        expect(token.user.toString()).toBe(a.user._id.toString());
    });

    it('POST /api/telegram/telegram-unbind unbinds A only', async () => {
        const res = await request(app).post('/api/telegram/telegram-unbind').set(bearer(a.user))
            .send({ userId: b.user._id.toString() });

        expect(res.status).toBe(200);
        expect((await User.findById(a.user._id)).telegramId).toBeUndefined();
        expect((await User.findById(b.user._id)).telegramId).toBe('2002');
    });
});

describe('someone else\'s ids are 404 and leave the owner\'s data untouched', () => {
    const expectBUnchanged = async () => {
        const fund = await Fund.findById(b.fund._id);

        expect(fund).not.toBeNull();
        expect(fund.name).toBe('Wallet');
        expect(fund.currentBalance).toBe(1000);
        expect(await FundTransaction.countDocuments({ fundId: b.fund._id })).toBe(1);
        expect(await Cost.countDocuments()).toBe(0);
    };

    it('GET /api/funds/:id', async () => {
        const res = await request(app).get(`/api/funds/${b.fund._id}`).set(bearer(a.user));

        expect(res.status).toBe(404);
        expect(res.body.name).toBeUndefined();
    });

    it('PUT /api/funds/:id', async () => {
        const res = await request(app).put(`/api/funds/${b.fund._id}`).set(bearer(a.user))
            .send({ name: 'Mine now', currentBalance: 0 });

        expect(res.status).toBe(404);
        await expectBUnchanged();
    });

    it('DELETE /api/funds/:id', async () => {
        const res = await request(app).delete(`/api/funds/${b.fund._id}`).set(bearer(a.user));

        expect(res.status).toBe(404);
        await expectBUnchanged();
    });

    it('GET /api/funds/:id/transactions', async () => {
        const res = await request(app).get(`/api/funds/${b.fund._id}/transactions`).set(bearer(a.user));

        expect(res.status).toBe(404);
        expect(Array.isArray(res.body)).toBe(false);
    });

    it('POST /api/cost with B\'s fund', async () => {
        const res = await request(app).post('/api/cost').set(bearer(a.user))
            .send(costBody(a, { fundId: b.fund._id.toString() }));

        expect(res.status).toBe(404);
        await expectBUnchanged();
    });

    it('POST /api/cost with B\'s fund through the bot', async () => {
        const res = await request(app).post('/api/cost').set(botHeaders('1001'))
            .send(costBody(a, { fundId: b.fund._id.toString() }));

        expect(res.status).toBe(404);
        await expectBUnchanged();
    });

    it('POST /api/cost with B\'s category, before any money moves', async () => {
        const res = await request(app).post('/api/cost').set(bearer(a.user))
            .send(costBody(a, { category: b.category._id.toString() }));

        expect(res.status).toBe(404);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(1000);
        await expectBUnchanged();
    });

    it('POST /api/cost accepts a global category', async () => {
        const global = await seedCategory(null, { name: 'Global' });

        const res = await request(app).post('/api/cost').set(bearer(a.user))
            .send(costBody(a, { category: global._id.toString() }));

        expect(res.status).toBe(201);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(990);
    });

    it('POST /api/funds/transfer from A\'s fund into B\'s', async () => {
        const res = await request(app).post('/api/funds/transfer').set(bearer(a.user))
            .send({ fromFundId: a.fund._id.toString(), toFundId: b.fund._id.toString(), amount: 100 });

        expect(res.status).toBe(404);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(1000);
        await expectBUnchanged();
    });

    it('POST /api/funds/transfer out of B\'s fund', async () => {
        const res = await request(app).post('/api/funds/transfer').set(bearer(a.user))
            .send({ fromFundId: b.fund._id.toString(), toFundId: a.fund._id.toString(), amount: 100 });

        expect(res.status).toBe(404);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(1000);
        await expectBUnchanged();
    });
});

describe('malformed ids are 404, not 500', () => {
    it.each([
        ['GET', 'get', '/api/funds/not-an-id'],
        ['PUT', 'put', '/api/funds/not-an-id'],
        ['DELETE', 'delete', '/api/funds/not-an-id'],
        ['GET transactions', 'get', '/api/funds/not-an-id/transactions']
    ])('%s %s', async (label, method, path) => {
        const res = await request(app)[method](path).set(bearer(a.user)).send({ name: 'x' });

        expect(res.status).toBe(404);
    });

    it.each([
        ['fundId', { fundId: 'not-an-id' }],
        ['fundId as an object', { fundId: { $ne: null } }],
        ['category', { category: 'not-an-id' }],
        ['category as an object', { category: { $ne: null } }],
        ['missing category', { category: undefined }]
    ])('POST /api/cost with a malformed %s', async (label, overrides) => {
        const res = await request(app).post('/api/cost').set(bearer(a.user)).send(costBody(a, overrides));

        expect(res.status).toBe(404);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(1000);
        expect(await Cost.countDocuments()).toBe(0);
    });

    it.each([
        ['fromFundId', { fromFundId: 'not-an-id' }],
        ['toFundId', { toFundId: 'not-an-id' }],
        ['fromFundId as an object', { fromFundId: { $ne: null } }]
    ])('POST /api/funds/transfer with a malformed %s', async (label, overrides) => {
        const res = await request(app).post('/api/funds/transfer').set(bearer(a.user))
            .send({ fromFundId: a.fund._id.toString(), toFundId: a.otherFund._id.toString(), amount: 5, ...overrides });

        expect(res.status).toBe(404);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(1000);
    });
});

describe('POST /api/cost amount', () => {
    it.each([
        ['zero', 0],
        ['negative', -50],
        ['a word', 'lots'],
        ['an empty string', ''],
        ['Infinity as a string', 'Infinity'],
        ['null', null],
        ['a boolean', true],
        ['an array', [5]],
        ['missing', undefined]
    ])('is 400 when it is %s, and the fund keeps its balance', async (label, amount) => {
        const res = await request(app).post('/api/cost').set(bearer(a.user)).send(costBody(a, { amount }));

        expect(res.status).toBe(400);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(1000);
        expect(await Cost.countDocuments()).toBe(0);
    });

    it('accepts a numeric string as the web form sends it', async () => {
        const res = await request(app).post('/api/cost').set(bearer(a.user)).send(costBody(a, { amount: '12.5' }));

        expect(res.status).toBe(201);
        expect(res.body.amount).toBe(12.5);
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(987.5);
    });

    it('without a fund saves in the user\'s currency', async () => {
        const res = await request(app).post('/api/cost').set(bearer(a.user)).send(costBody(a, { fundId: undefined }));

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ currency: 'USD', rate: 1, fund: null, user: a.user._id.toString() });
    });
});

describe('the bot', () => {
    it('sees A\'s funds by A\'s Telegram id', async () => {
        const res = await request(app).get('/api/funds').set(botHeaders('1001'));

        expect(res.status).toBe(200);
        expect(res.body.funds.every(fund => fund.userId === a.user._id.toString())).toBe(true);
        expect(res.body.funds).toHaveLength(2);
    });

    it('saves a cost for the Telegram user, ignoring a userId in the body', async () => {
        const res = await request(app).post('/api/cost').set(botHeaders('1001'))
            .send(costBody(a, { userId: b.user._id.toString() }));

        expect(res.status).toBe(201);
        expect(res.body.user).toBe(a.user._id.toString());
        expect((await Fund.findById(a.fund._id)).currentBalance).toBe(990);
    });

    it('is 403 with an empty secret, even with a linked Telegram id', async () => {
        const res = await request(app).get('/api/funds').set({ 'X-Telegram-Bot-Secret': '', 'X-Telegram-User-Id': '1001' });

        expect(res.status).toBe(403);
    });

    it('legacy: the secret and a userId reach A\'s data and are logged', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(app).get(`/api/funds?userId=${a.user._id}`).set(botHeaders());

        expect(res.status).toBe(200);
        expect(res.body.funds).toHaveLength(2);
        expect(res.body.funds[0].userId).toBe(a.user._id.toString());
        expect(warn).toHaveBeenCalledWith('[auth-legacy]', 'bot', 'GET', '/api/funds');
    });

    it('legacy: the secret with a malformed userId is 401', async () => {
        const res = await request(app).get('/api/funds?userId=not-an-id').set(botHeaders());

        expect(res.status).toBe(401);
    });
});

describe('legacy web', () => {
    it('A\'s cookie with userId=B acts on A', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(app).post('/api/cost').set('Cookie', cookieFor(a.user))
            .send(costBody(a, { userId: b.user._id.toString() }));

        expect(res.status).toBe(201);
        expect(res.body.user).toBe(a.user._id.toString());
    });

    it('A\'s cookie with B\'s fund is 404', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await request(app).post('/api/cost').set('Cookie', cookieFor(a.user))
            .send(costBody(a, { fundId: b.fund._id.toString() }));

        expect(res.status).toBe(404);
        expect((await Fund.findById(b.fund._id)).currentBalance).toBe(1000);
    });
});

describe('telegram binding', () => {
    it('GET /telegram-binding-link?userId=B without credentials mints nothing', async () => {
        const res = await request(app).get(`/api/telegram/telegram-binding-link?userId=${b.user._id}`);

        expect(res.status).toBe(401);
        expect(await TelegramBindingToken.countDocuments()).toBe(0);
    });

    it('binding a Telegram id clears it on any other user holding it', async () => {
        const c = await seedUser({ telegramId: '3003' });
        await User.updateOne({ _id: b.user._id }, { telegramId: '3003' });
        await TelegramBindingToken.create({ token: 'abc', user: a.user._id });

        const res = await request(app).post('/api/telegram/telegram-bind').set(botHeaders())
            .send({ token: 'bind_abc', telegramId: 3003 });

        expect(res.status).toBe(200);
        expect((await User.findById(a.user._id)).telegramId).toBe('3003');
        expect((await User.findById(b.user._id)).telegramId).toBeUndefined();
        expect((await User.findById(c._id)).telegramId).toBeUndefined();
        expect(await User.countDocuments({ telegramId: '3003' })).toBe(1);
    });
});
