const request = require('supertest');
const app = require('../app');
const { seedUser, TEST_PASSWORD } = require('./helpers');

describe('smoke', () => {
    it('signs a seeded user in', async () => {
        const user = await seedUser();

        const res = await request(app)
            .post('/api/auth/signin')
            .send({ email: user.email, password: TEST_PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body.accessToken).toEqual(expect.any(String));
    });

    it('serves the public currency list', async () => {
        const res = await request(app).get('/api/exchange-rates/currencies');

        expect(res.status).toBe(200);
        expect(res.body.count).toBeGreaterThan(0);
    });
});
