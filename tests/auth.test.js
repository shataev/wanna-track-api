const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('nodemailer', () => ({
    createTransport: () => ({ sendMail: (config, callback) => callback(null, { accepted: [config.to] }) })
}));

const app = require('../app');
const { seedUser, cookieFor, TEST_PASSWORD } = require('./helpers');

const FULL_USER_KEYS = ['id', 'username', 'email', 'defaultCurrency', 'telegramId', 'verified'];

const refreshCookieOf = (res) => (res.headers['set-cookie'] || []).find(cookie => cookie.startsWith('refreshToken='));

const expectFullUser = (body, user) => {
    expect(Object.keys(body)).toEqual(expect.arrayContaining(FULL_USER_KEYS));
    expect(body).toMatchObject({
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        defaultCurrency: user.defaultCurrency,
        telegramId: user.telegramId ?? null,
        verified: user.verified
    });
};

describe('POST /api/auth/refresh', () => {
    it('returns a new access token and the full user, and rotates the cookie', async () => {
        const user = await seedUser({ telegramId: '111', verified: true });

        const res = await request(app).post('/api/auth/refresh').set('Cookie', cookieFor(user));

        expect(res.status).toBe(200);
        expectFullUser(res.body.user, user);

        const payload = jwt.verify(res.body.accessToken, process.env.SECRET_KEY);
        expect(payload.id).toBe(user._id.toString());

        const cookie = refreshCookieOf(res);
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/Secure/);
    });

    it('is 401 without the cookie', async () => {
        const res = await request(app).post('/api/auth/refresh');

        expect(res.status).toBe(401);
        expect(refreshCookieOf(res)).toBeUndefined();
    });

    it('is 401 with an expired cookie', async () => {
        const user = await seedUser();
        const expired = jwt.sign({ userId: user._id.toString() }, process.env.SECRET_KEY_REFRESH, { expiresIn: -10 });

        const res = await request(app).post('/api/auth/refresh').set('Cookie', `refreshToken=${expired}`);

        expect(res.status).toBe(401);
    });

    it('is 401 with a cookie signed by another key', async () => {
        const user = await seedUser();
        const forged = jwt.sign({ userId: user._id.toString() }, 'not-the-refresh-secret');

        const res = await request(app).post('/api/auth/refresh').set('Cookie', `refreshToken=${forged}`);

        expect(res.status).toBe(401);
    });

    it('is 401 when the user no longer exists', async () => {
        const user = await seedUser();
        const cookie = cookieFor(user);
        await user.deleteOne();

        const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie);

        expect(res.status).toBe(401);
    });
});

describe('signin and signup', () => {
    it('signin returns the full user and an access token, without X-Verification-Code', async () => {
        const user = await seedUser({ telegramId: '222', defaultCurrency: 'THB' });

        const res = await request(app)
            .post('/api/auth/signin')
            .send({ email: user.email, password: TEST_PASSWORD });

        expect(res.status).toBe(200);
        expectFullUser(res.body, user);
        expectFullUser(res.body.user, user);
        expect(jwt.verify(res.body.accessToken, process.env.SECRET_KEY).id).toBe(user._id.toString());
        expect(refreshCookieOf(res)).toBeDefined();
    });

    it('signin with a wrong password is 401', async () => {
        const user = await seedUser();

        const res = await request(app)
            .post('/api/auth/signin')
            .send({ email: user.email, password: 'wrong' });

        expect(res.status).toBe(401);
    });

    it('signup returns the full user and an access token, without X-Verification-Code', async () => {
        const res = await request(app)
            .post('/api/auth/signup')
            .send({ username: 'newcomer', email: 'newcomer@example.test', password: 'pw' });

        expect(res.status).toBe(201);
        expect(Object.keys(res.body.user)).toEqual(expect.arrayContaining(FULL_USER_KEYS));
        expect(res.body).toMatchObject({ username: 'newcomer', email: 'newcomer@example.test', defaultCurrency: 'THB', verified: false });
        expect(res.body.user.id).toBe(res.body.id);
        expect(jwt.verify(res.body.accessToken, process.env.SECRET_KEY).id).toBe(res.body.id);
    });
});

describe('GET /api/auth/ (legacy silent auth)', () => {
    it('still answers the old bundle by cookie, without X-Verification-Code', async () => {
        const user = await seedUser();

        const res = await request(app).get('/api/auth/').set('Cookie', cookieFor(user));

        expect(res.status).toBe(201);
        expect(res.body.email).toBe(user.email);
    });
});
