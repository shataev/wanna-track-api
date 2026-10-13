const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
// superagent's cookie implementation: decides, as a browser does, where a Set-Cookie is sent and who reads it
const { Cookie, CookieAccessInfo } = require('cookiejar');

jest.mock('nodemailer', () => ({
    createTransport: () => ({ sendMail: (config, callback) => callback(null, { accepted: [config.to] }) })
}));

const app = require('../app');
const Session = require('../models/Session');
const { describeDevice, ROTATION_GRACE_MS } = require('../services/sessionService');
const { seedUser, bearer, cookieFor, TEST_PASSWORD } = require('./helpers');

const DAY_MS = 24 * 60 * 60 * 1000;
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const refreshCookies = (res) => (res.headers['set-cookie'] || []).filter(cookie => cookie.startsWith('refreshToken='));

// The cookie that carries a secret, not one that clears
const sessionCookieOf = (res) => refreshCookies(res).find(cookie => !cookie.startsWith('refreshToken=;'));

const secretOf = (res) => {
    const cookie = sessionCookieOf(res);

    return cookie ? decodeURIComponent(cookie.split(';')[0].slice('refreshToken='.length)) : undefined;
};

const asCookie = (secret) => `refreshToken=${secret}`;

const signIn = (user, userAgent = MAC_CHROME) => request(app)
    .post('/api/auth/signin')
    .set('User-Agent', userAgent)
    .send({ email: user.email, password: TEST_PASSWORD });

const refresh = (secret) => request(app).post('/api/auth/refresh').set('Cookie', asCookie(secret));

const sidOf = (res) => jwt.verify(res.body.accessToken, process.env.SECRET_KEY).sid;

const bearerOf = (res) => ({ Authorization: `Bearer ${res.body.accessToken}` });

// Only Date is faked: the database driver keeps its real timers
const useFakeDate = () => jest.useFakeTimers({
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout'],
    now: Date.now()
});

const travel = (ms) => jest.setSystemTime(Date.now() + ms);

afterEach(() => {
    jest.useRealTimers();
});

describe('sign-in', () => {
    it('creates a session and sets the cookie at /api/auth, httpOnly, secure, lax, living 90 days', async () => {
        const user = await seedUser();

        const res = await signIn(user, IPHONE_SAFARI).set('X-Forwarded-For', '203.0.113.7');

        expect(res.status).toBe(200);

        const cookie = sessionCookieOf(res);
        expect(cookie).toMatch(/; Path=\/api\/auth(;|$)/);
        expect(cookie).toMatch(/; HttpOnly/);
        expect(cookie).toMatch(/; Secure/);
        expect(cookie).toMatch(/; SameSite=Lax/);
        const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1]);
        expect(Math.abs(maxAge - 90 * 24 * 60 * 60)).toBeLessThanOrEqual(5);

        const sessions = await Session.find({ user: user._id });
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
            tokenHash: sha256(secretOf(res)),
            previousHash: null,
            userAgent: IPHONE_SAFARI.slice(0, 200),
            ip: '203.0.113.7',
            revokedAt: null
        });
        expect(sessions[0].absoluteExpiresAt - sessions[0].lastUsedAt).toBe(180 * DAY_MS);
        expect(sidOf(res)).toBe(sessions[0]._id.toString());
    });

    it('clears the cookie of before sessions at path /', async () => {
        const user = await seedUser();

        const res = await signIn(user);

        const legacy = refreshCookies(res).find(cookie => /; Path=\/(;|$)/.test(cookie));
        expect(legacy).toMatch(/^refreshToken=;/);
        expect(legacy).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('signup creates a session too', async () => {
        const res = await request(app)
            .post('/api/auth/signup')
            .send({ username: 'fresh', email: 'fresh@example.test', password: 'pw' });

        expect(res.status).toBe(201);
        expect(await Session.countDocuments({ user: res.body.id, tokenHash: sha256(secretOf(res)) })).toBe(1);
    });

    it('keeps the user agent to 200 characters', async () => {
        const user = await seedUser();

        await signIn(user, `${MAC_CHROME} ${'x'.repeat(400)}`);

        expect((await Session.findOne({ user: user._id })).userAgent).toHaveLength(200);
    });
});

describe('the cookie in a browser', () => {
    it('is sent to /api/auth only and not readable by scripts', async () => {
        const user = await seedUser();
        const res = await signIn(user);
        const cookie = Cookie(sessionCookieOf(res), 'api.wannatrack.test', '/api/auth/signin');

        const at = (path, script = false) => cookie.matches(new CookieAccessInfo('api.wannatrack.test', path, true, script));

        expect(at('/api/auth/refresh')).toBe(true);
        expect(at('/api/auth/signout')).toBe(true);
        expect(at('/api/funds')).toBe(false);
        expect(at('/api/cost')).toBe(false);
        expect(at('/api/sessions')).toBe(false);
        expect(at('/api/auth/refresh', true)).toBe(false);
    });
});

describe('POST /api/auth/refresh', () => {
    it('rotates: a new secret in the cookie, the old hash kept as previousHash, the window slid', async () => {
        useFakeDate();
        const user = await seedUser();
        const signedIn = await signIn(user);
        const first = secretOf(signedIn);
        const before = await Session.findOne({ user: user._id });

        travel(DAY_MS);
        const res = await refresh(first);

        expect(res.status).toBe(200);
        expect(res.body.user.id).toBe(user._id.toString());
        const second = secretOf(res);
        expect(second).toBeDefined();
        expect(second).not.toBe(first);
        expect(sessionCookieOf(res)).toMatch(/; Path=\/api\/auth(;|$)/);
        expect(sidOf(res)).toBe(before._id.toString());

        const after = await Session.findById(before._id);
        expect(after.tokenHash).toBe(sha256(second));
        expect(after.previousHash).toBe(sha256(first));
        expect(after.family).toBe(before.family);
        expect(after.expiresAt - before.expiresAt).toBe(DAY_MS);
        expect(after.lastUsedAt.getTime()).toBe(Date.now());
        expect(after.absoluteExpiresAt).toEqual(before.absoluteExpiresAt);
        expect(await Session.countDocuments()).toBe(1);

        expect((await refresh(second)).status).toBe(200);
    });

    it('accepts the replaced secret within the grace window: same session, no new cookie, nothing revoked', async () => {
        useFakeDate();
        const user = await seedUser();
        const first = secretOf(await signIn(user));
        const rotated = await refresh(first);
        const second = secretOf(rotated);

        travel(ROTATION_GRACE_MS - 1000);
        const late = await refresh(first);

        expect(late.status).toBe(200);
        expect(sidOf(late)).toBe(sidOf(rotated));
        expect(late.body.user.id).toBe(user._id.toString());
        expect(sessionCookieOf(late)).toBeUndefined();

        const session = await Session.findOne({ user: user._id });
        expect(session.revokedAt).toBeNull();
        expect(session.tokenHash).toBe(sha256(second));

        expect((await refresh(second)).status).toBe(200);
    });

    it('two refreshes with the same secret at once both succeed', async () => {
        const user = await seedUser();
        const secret = secretOf(await signIn(user));

        const [a, b] = await Promise.all([refresh(secret), refresh(secret)]);

        expect([a.status, b.status]).toEqual([200, 200]);
        expect(await Session.countDocuments({ revokedAt: null })).toBe(1);
    });

    it('revokes the whole session when the replaced secret comes back after the grace window', async () => {
        useFakeDate();
        const user = await seedUser();
        const first = secretOf(await signIn(user));
        const second = secretOf(await refresh(first));

        travel(ROTATION_GRACE_MS + 1000);
        const reused = await refresh(first);

        expect(reused.status).toBe(401);
        expect(sessionCookieOf(reused)).toBeUndefined();
        expect((await Session.findOne({ user: user._id })).revokedAt).not.toBeNull();

        // The holder of the current secret is out as well: either of them may be the thief
        expect((await refresh(second)).status).toBe(401);
    });

    it('is 401 once the sliding window has passed without a refresh', async () => {
        useFakeDate();
        const user = await seedUser();
        const secret = secretOf(await signIn(user));

        travel(90 * DAY_MS + 1000);

        expect((await refresh(secret)).status).toBe(401);
    });

    it('lets a session used every day live 180 days from sign-in, not a day more', async () => {
        useFakeDate();
        const user = await seedUser();
        const signedInAt = Date.now();
        let secret = secretOf(await signIn(user));

        for (let day = 1; day < 180; day += 1) {
            travel(DAY_MS);
            const res = await refresh(secret);

            expect(res.status).toBe(200);
            secret = secretOf(res);
        }

        const session = await Session.findOne({ user: user._id });
        expect(session.expiresAt.getTime()).toBe(signedInAt + 180 * DAY_MS);
        // The cookie expires with the session
        expect(Date.now() + 1000 * Number(sessionCookieOf(await refresh(secret)).match(/Max-Age=(\d+)/)[1]))
            .toBeLessThanOrEqual(signedInAt + 180 * DAY_MS);
    });

    it('is 401 at the absolute cap even for a session refreshed the moment before', async () => {
        useFakeDate();
        const user = await seedUser();
        const signedInAt = Date.now();
        let secret = secretOf(await signIn(user));

        for (let day = 1; day < 180; day += 1) {
            jest.setSystemTime(signedInAt + day * DAY_MS);
            secret = secretOf(await refresh(secret));
        }

        jest.setSystemTime(signedInAt + 180 * DAY_MS);

        expect((await refresh(secret)).status).toBe(401);
    });

    it('is 401 for a revoked session, an unknown secret and a deleted user', async () => {
        const user = await seedUser();
        const revoked = secretOf(await signIn(user));
        await Session.updateOne({ tokenHash: sha256(revoked) }, { revokedAt: new Date() });

        expect((await refresh(revoked)).status).toBe(401);
        expect((await refresh(crypto.randomBytes(32).toString('base64url'))).status).toBe(401);

        const other = await seedUser();
        const orphan = secretOf(await signIn(other));
        await other.deleteOne();

        expect((await refresh(orphan)).status).toBe(401);
    });

    it('uses the session cookie when the browser still sends the old one at / after it', async () => {
        const user = await seedUser();
        const secret = secretOf(await signIn(user));

        // A browser sends the cookie of the longer path first
        const res = await request(app).post('/api/auth/refresh').set('Cookie', `${asCookie(secret)}; ${cookieFor(user)}`);

        expect(res.status).toBe(200);
        expect(await Session.countDocuments()).toBe(1);
        expect((await Session.findOne()).previousHash).toBe(sha256(secret));
    });
});

describe('migration of a refresh JWT from before sessions', () => {
    it('turns it into a session once, on POST /refresh', async () => {
        useFakeDate();
        const user = await seedUser();
        const legacy = cookieFor(user);

        const res = await request(app).post('/api/auth/refresh').set('User-Agent', IPHONE_SAFARI).set('Cookie', legacy);

        expect(res.status).toBe(200);
        expect(res.body.user.id).toBe(user._id.toString());
        const sessions = await Session.find({ user: user._id });
        expect(sessions).toHaveLength(1);
        expect(sessions[0].tokenHash).toBe(sha256(secretOf(res)));
        expect(sidOf(res)).toBe(sessions[0]._id.toString());
        // Moves the browser off the old cookie
        expect(refreshCookies(res).find(cookie => /; Path=\/(;|$)/.test(cookie))).toMatch(/^refreshToken=;/);

        // A second tab with the same old cookie at the same moment joins that session
        const again = await request(app).post('/api/auth/refresh').set('Cookie', legacy);
        expect(again.status).toBe(200);
        expect(sidOf(again)).toBe(sessions[0]._id.toString());
        expect(await Session.countDocuments()).toBe(1);

        // Later it is a copy, as any replaced secret
        travel(ROTATION_GRACE_MS + 1000);
        expect((await request(app).post('/api/auth/refresh').set('Cookie', legacy)).status).toBe(401);
        expect(await Session.countDocuments()).toBe(1);
    });

    it('turns it into a session on the legacy GET /api/auth/ too', async () => {
        const user = await seedUser();

        const res = await request(app).get('/api/auth/').set('Cookie', cookieFor(user));

        expect(res.status).toBe(201);
        expect(res.body.email).toBe(user.email);
        expect(await Session.countDocuments({ user: user._id, tokenHash: sha256(secretOf(res)) })).toBe(1);
    });

    it('does not migrate an expired or forged JWT', async () => {
        const user = await seedUser();
        const expired = jwt.sign({ userId: user._id.toString() }, process.env.SECRET_KEY_REFRESH, { expiresIn: -10 });
        const forged = jwt.sign({ userId: user._id.toString() }, 'not-the-refresh-secret');

        expect((await refresh(expired)).status).toBe(401);
        expect((await refresh(forged)).status).toBe(401);
        expect(await Session.countDocuments()).toBe(0);
    });
});

describe('POST /api/auth/signout', () => {
    it('revokes the session and clears the cookie at both paths, without an access token', async () => {
        const user = await seedUser();
        const secret = secretOf(await signIn(user));

        const res = await request(app).post('/api/auth/signout').set('Cookie', asCookie(secret));

        expect(res.status).toBe(200);
        const cleared = refreshCookies(res);
        expect(cleared).toEqual(expect.arrayContaining([
            expect.stringMatching(/^refreshToken=;.*Path=\/api\/auth(;|$)/),
            expect.stringMatching(/^refreshToken=;.*Path=\/(;|$)/)
        ]));
        expect(cleared.every(cookie => /Expires=Thu, 01 Jan 1970/.test(cookie))).toBe(true);

        expect((await Session.findOne({ user: user._id })).revokedAt).not.toBeNull();
        expect((await refresh(secret)).status).toBe(401);
    });

    it('signs out a tab still holding the secret just replaced', async () => {
        const user = await seedUser();
        const first = secretOf(await signIn(user));
        const second = secretOf(await refresh(first));

        await request(app).post('/api/auth/signout').set('Cookie', asCookie(first));

        expect((await refresh(second)).status).toBe(401);
    });

    it('leaves the other sessions alone and answers 200 without a cookie', async () => {
        const user = await seedUser();
        const phone = secretOf(await signIn(user, IPHONE_SAFARI));
        const laptop = secretOf(await signIn(user));

        await request(app).post('/api/auth/signout').set('Cookie', asCookie(laptop));

        expect((await request(app).post('/api/auth/signout')).status).toBe(200);
        expect((await refresh(phone)).status).toBe(200);
    });
});

describe('secrets at rest', () => {
    it('the database holds only hashes of the secrets, never the secrets', async () => {
        const user = await seedUser();
        const secrets = [];
        let res = await signIn(user);
        secrets.push(secretOf(res));
        res = await refresh(secrets[0]);
        secrets.push(secretOf(res));
        res = await refresh(secrets[1]);
        secrets.push(secretOf(res));

        const stored = JSON.stringify(await Session.find().lean());

        for (const secret of secrets) {
            expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
            expect(stored).not.toContain(secret);
        }
        expect(stored).toContain(sha256(secrets[2]));
        expect(stored).toContain(sha256(secrets[1]));
    });
});

describe('legacy cookie fallback of authenticate', () => {
    it('reads the session; a revoked one is a 401; AUTH_ENFORCE=true ignores the cookie', async () => {
        const user = await seedUser();
        const secret = secretOf(await signIn(user));

        expect((await request(app).get('/api/me').set('Cookie', asCookie(secret))).status).toBe(200);

        process.env.AUTH_ENFORCE = 'true';
        expect((await request(app).get('/api/me').set('Cookie', asCookie(secret))).status).toBe(401);
        delete process.env.AUTH_ENFORCE;

        await request(app).post('/api/auth/signout').set('Cookie', asCookie(secret));
        expect((await request(app).get('/api/me').set('Cookie', asCookie(secret))).status).toBe(401);
    });
});

describe('session list API', () => {
    // A and B each signed in on a laptop and a phone; A's laptop is the caller
    const seedTwoUsers = async () => {
        useFakeDate();
        const a = await seedUser();
        const b = await seedUser();

        const aPhone = await signIn(a, IPHONE_SAFARI);
        travel(60 * 1000);
        const bLaptop = await signIn(b);
        travel(60 * 1000);
        const aLaptop = await signIn(a, MAC_CHROME);
        travel(60 * 1000);
        // The phone was used last
        const aPhoneRefreshed = await refresh(secretOf(aPhone));

        return { a, b, aPhone: aPhoneRefreshed, aLaptop, bLaptop };
    };

    describe('GET /api/sessions', () => {
        it("lists the caller's active sessions, the current one first, then the most recently used", async () => {
            const { aPhone, aLaptop } = await seedTwoUsers();

            const res = await request(app).get('/api/sessions').set(bearerOf(aLaptop));

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(2);
            expect(res.body.map(session => [session.id, session.current, session.device])).toEqual([
                [sidOf(aLaptop), true, 'Mac · Chrome'],
                [sidOf(aPhone), false, 'iPhone · Safari']
            ]);
            expect(Object.keys(res.body[0]).sort()).toEqual(['createdAt', 'current', 'device', 'expiresAt', 'id', 'lastUsedAt']);
            // The secrets and their hashes stay in the database
            expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|previousHash|family/);
        });

        it('orders the rest by last use, and leaves out revoked and expired sessions', async () => {
            const { a, aPhone, aLaptop } = await seedTwoUsers();
            const tablet = await signIn(a, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36');
            const old = await signIn(a);
            await Session.updateOne({ _id: sidOf(old) }, { expiresAt: new Date(Date.now() - 1000) });
            const gone = await signIn(a);
            await Session.updateOne({ _id: sidOf(gone) }, { revokedAt: new Date() });

            const res = await request(app).get('/api/sessions').set(bearerOf(aPhone));

            expect(res.body.map(session => session.id)).toEqual([sidOf(aPhone), sidOf(tablet), sidOf(aLaptop)]);
            expect(res.body[1].device).toBe('Android · Chrome');
        });

        it('needs an access token', async () => {
            expect((await request(app).get('/api/sessions')).status).toBe(401);
        });
    });

    describe('DELETE /api/sessions/:id', () => {
        it('signs one of the caller\'s other devices out', async () => {
            const { aPhone, aLaptop } = await seedTwoUsers();

            const res = await request(app).delete(`/api/sessions/${sidOf(aPhone)}`).set(bearerOf(aLaptop));

            expect(res.status).toBe(204);
            expect(refreshCookies(res)).toHaveLength(0);
            expect((await refresh(secretOf(aPhone))).status).toBe(401);
            expect((await refresh(secretOf(aLaptop))).status).toBe(200);
        });

        it('signs the current device out and clears its cookie', async () => {
            const { aLaptop } = await seedTwoUsers();

            const res = await request(app).delete(`/api/sessions/${sidOf(aLaptop)}`).set(bearerOf(aLaptop));

            expect(res.status).toBe(204);
            expect(refreshCookies(res)).toEqual(expect.arrayContaining([
                expect.stringMatching(/^refreshToken=;.*Path=\/api\/auth(;|$)/),
                expect.stringMatching(/^refreshToken=;.*Path=\/(;|$)/)
            ]));
            expect((await refresh(secretOf(aLaptop))).status).toBe(401);
        });

        it("is 404 for another user's session, which stays signed in", async () => {
            const { bLaptop, aLaptop } = await seedTwoUsers();

            const res = await request(app).delete(`/api/sessions/${sidOf(bLaptop)}`).set(bearerOf(aLaptop));

            expect(res.status).toBe(404);
            expect((await Session.findById(sidOf(bLaptop))).revokedAt).toBeNull();
            expect((await refresh(secretOf(bLaptop))).status).toBe(200);
        });

        it('is 404 for a malformed, unknown or already revoked id', async () => {
            const { aPhone, aLaptop } = await seedTwoUsers();
            await request(app).delete(`/api/sessions/${sidOf(aPhone)}`).set(bearerOf(aLaptop));

            for (const id of ['not-an-id', '64b7f0c2a1b2c3d4e5f60718', sidOf(aPhone)]) {
                expect((await request(app).delete(`/api/sessions/${id}`).set(bearerOf(aLaptop))).status).toBe(404);
            }
        });

        it('needs an access token, not the refresh cookie', async () => {
            const { aLaptop } = await seedTwoUsers();
            process.env.AUTH_ENFORCE = 'true';

            const res = await request(app).delete(`/api/sessions/${sidOf(aLaptop)}`).set('Cookie', asCookie(secretOf(aLaptop)));

            expect(res.status).toBe(401);
        });
    });

    describe('POST /api/sessions/revoke-others', () => {
        it("revokes all the caller's sessions but the current one, and nobody else's", async () => {
            const { a, aPhone, aLaptop, bLaptop } = await seedTwoUsers();
            const aTablet = await signIn(a);

            const res = await request(app).post('/api/sessions/revoke-others').set(bearerOf(aLaptop));

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ revoked: 2 });
            expect((await refresh(secretOf(aPhone))).status).toBe(401);
            expect((await refresh(secretOf(aTablet))).status).toBe(401);
            expect((await refresh(secretOf(aLaptop))).status).toBe(200);
            expect((await refresh(secretOf(bLaptop))).status).toBe(200);
        });

        it('is 409 for an access token that names no session, and revokes nothing', async () => {
            const { a, aPhone } = await seedTwoUsers();

            // An access token issued before sessions, as the helper signs it
            const res = await request(app).post('/api/sessions/revoke-others').set(bearer(a));

            expect(res.status).toBe(409);
            expect((await refresh(secretOf(aPhone))).status).toBe(200);
        });
    });
});

describe('describeDevice', () => {
    it.each([
        [IPHONE_SAFARI, 'iPhone · Safari'],
        [MAC_CHROME, 'Mac · Chrome'],
        ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'iPhone · Chrome'],
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0', 'Mac · Firefox'],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Windows · Edge'],
        ['Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'Android · Samsung Internet'],
        ['curl/8.5.0', 'Unknown device'],
        ['', 'Unknown device'],
        [undefined, 'Unknown device']
    ])('%s → %s', (userAgent, expected) => {
        expect(describeDevice(userAgent)).toBe(expected);
    });
});
