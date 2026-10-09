const request = require('supertest');

jest.mock('../services/exchangeRateService', () => ({
    ...jest.requireActual('../services/exchangeRateService'),
    updateRates: jest.fn()
}));

const { updateRates } = require('../services/exchangeRateService');
const app = require('../app');

describe('POST /api/exchange-rates/update', () => {
    beforeEach(() => {
        updateRates.mockReset();
        updateRates.mockResolvedValue({ base: 'USD', rates: new Map([['THB', 36]]), updatedAt: new Date() });
    });

    it('does not exist while ADMIN_SECRET is unset', async () => {
        const res = await request(app).post('/api/exchange-rates/update').set('X-Admin-Secret', 'anything');

        expect(res.status).toBe(404);
        expect(updateRates).not.toHaveBeenCalled();
    });

    it('is 403 without the header', async () => {
        process.env.ADMIN_SECRET = 'test-admin-secret';

        const res = await request(app).post('/api/exchange-rates/update');

        expect(res.status).toBe(403);
        expect(updateRates).not.toHaveBeenCalled();
    });

    it('is 403 with a wrong secret', async () => {
        process.env.ADMIN_SECRET = 'test-admin-secret';

        const res = await request(app).post('/api/exchange-rates/update').set('X-Admin-Secret', 'test-admin-secreT');

        expect(res.status).toBe(403);
        expect(updateRates).not.toHaveBeenCalled();
    });

    it('updates with the right secret', async () => {
        process.env.ADMIN_SECRET = 'test-admin-secret';

        const res = await request(app).post('/api/exchange-rates/update').set('X-Admin-Secret', 'test-admin-secret');

        expect(res.status).toBe(200);
        expect(res.body.rates).toEqual({ THB: 36, USD: 1 });
        expect(updateRates).toHaveBeenCalledTimes(1);
    });

    it('leaves the read routes public', async () => {
        const res = await request(app).get('/api/exchange-rates/currencies');

        expect(res.status).toBe(200);
    });
});
