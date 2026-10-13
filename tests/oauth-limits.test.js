const request = require('supertest');
const app = require('../app');
const OAuthClient = require('../models/OAuthClient');
const OAuthGrant = require('../models/OAuthGrant');
const loginGuard = require('../utils/loginGuard');
const { isAnthropicIp } = require('../utils/oauth.config');
const { seedUser, bearer } = require('./helpers');
const {
    nextIp,
    pkcePair,
    register,
    authorizationParams,
    nonceFrom,
    signIn,
    token,
    connect,
    oauthBearer
} = require('./oauth.helpers');

const ANTHROPIC_IP = '160.79.104.10';
const DAY_MS = 24 * 60 * 60 * 1000;

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
};

const mcp = (headers = {}, body = INITIALIZE) => request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set(headers)
    .send(body);

const grantsOf = async (user) => (await request(app).get('/api/oauth/grants').set(bearer(user))).body;

// Registrations nobody has allowed yet, as many as needed, without going through HTTP
let seeded = 0;

const seedPendingClients = (count, pendingUntil = new Date(Date.now() + DAY_MS)) => OAuthClient.insertMany(
    Array.from({ length: count }, () => ({
        clientId: `seeded-${seeded++}`,
        clientIdIssuedAt: Math.floor(Date.now() / 1000),
        clientName: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
        pendingUntil
    }))
);

let a;
let b;

beforeEach(async () => {
    loginGuard.reset();

    a = await seedUser({ defaultCurrency: 'THB' });
    b = await seedUser({ defaultCurrency: 'THB' });
});

describe('registration keeps only what the server needs', () => {
    test('extra metadata is neither stored nor echoed', async () => {
        const res = await register({
            client_name: '  Claude  ',
            software_statement: 'x'.repeat(10 * 1024),
            logo_uri: 'https://claude.ai/logo.png',
            contacts: ['someone@example.test'],
            client_uri: 'https://claude.ai',
            scope: 'expenses.read'
        });

        expect(res.status).toBe(201);
        expect(Object.keys(res.body).sort()).toEqual([
            'client_id',
            'client_id_issued_at',
            'client_name',
            'grant_types',
            'redirect_uris',
            'response_types',
            'token_endpoint_auth_method'
        ]);
        expect(res.body.client_name).toBe('Claude');

        const stored = await OAuthClient.findOne({ clientId: res.body.client_id }).lean();

        expect(Object.keys(stored).sort()).toEqual([
            '__v',
            '_id',
            'clientId',
            'clientIdIssuedAt',
            'clientName',
            'createdAt',
            'pendingUntil',
            'redirectUris',
            'updatedAt'
        ]);
        expect(JSON.stringify(stored)).not.toContain('xxxxxxxx');
    });

    test('the client name is cut to 100 characters', async () => {
        const res = await register({ client_name: 'C'.repeat(500) });

        expect(res.body.client_name).toHaveLength(100);
        expect((await OAuthClient.findOne({ clientId: res.body.client_id })).clientName).toHaveLength(100);
    });

    test('a registration body over 16 KB is refused and nothing is stored', async () => {
        const res = await register({ software_statement: 'x'.repeat(17 * 1024) });

        expect(res.status).toBe(413);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(await OAuthClient.countDocuments()).toBe(0);
    });

    test('just under 16 KB is accepted', async () => {
        const res = await register({ software_statement: 'x'.repeat(15 * 1024) });

        expect(res.status).toBe(201);
    });
});

describe('registrations nobody completes are dropped', () => {
    test('a new client is pending for 24 hours, with a TTL index on it', async () => {
        const res = await register();
        const stored = await OAuthClient.findOne({ clientId: res.body.client_id });

        expect(stored.pendingUntil - Date.now()).toBeGreaterThan(DAY_MS - 60 * 1000);
        expect(stored.pendingUntil - Date.now()).toBeLessThanOrEqual(DAY_MS);

        await OAuthClient.init();

        const indexes = await OAuthClient.collection.indexes();

        expect(indexes).toContainEqual(expect.objectContaining({ key: { pendingUntil: 1 }, expireAfterSeconds: 0 }));
    });

    test('once the user allows it, the client is no longer pending', async () => {
        const { client } = await connect(a);

        expect((await OAuthClient.findOne({ clientId: client.client_id })).pendingUntil).toBeNull();
    });

    test('a client past its pending time is gone at authorize and at the token endpoint, before MongoDB deletes it', async () => {
        const client = (await register()).body;

        await OAuthClient.updateOne({ clientId: client.client_id }, { pendingUntil: new Date(Date.now() - 1000) });

        const authorize = await request(app)
            .get('/oauth/authorize')
            .set('X-Forwarded-For', nextIp())
            .query(authorizationParams(client, pkcePair()));

        expect(authorize.status).toBe(400);

        const exchanged = await token({ grant_type: 'authorization_code', client_id: client.client_id, code: 'x', code_verifier: 'y' });

        expect(exchanged.status).toBe(401);
        expect(exchanged.body.error).toBe('invalid_client');
    });

    test('an allowed client stays registered after 24 hours', async () => {
        const { client, tokens } = await connect(a);

        await OAuthClient.updateOne({ clientId: client.client_id }, { createdAt: new Date(Date.now() - 2 * DAY_MS) });

        const refreshed = await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });

        expect(refreshed.status).toBe(200);
    });
});

describe('registration limits', () => {
    test('at most 200 pending registrations at a time, from any address: then 429', async () => {
        await seedPendingClients(200);

        const res = await register({}, ANTHROPIC_IP);

        expect(res.status).toBe(429);
        expect(res.body.error).toBe('too_many_requests');
        expect(await OAuthClient.countDocuments()).toBe(200);
    });

    test('expired and allowed clients do not count towards the cap', async () => {
        await seedPendingClients(150, new Date(Date.now() - 1000));
        await seedPendingClients(199);
        await connect(a);

        expect((await register({}, ANTHROPIC_IP)).status).toBe(201);
        expect((await register({}, ANTHROPIC_IP)).status).toBe(429);
    });

    test('Anthropic\'s egress range has no per-IP limit: 120 registrations from one address in it', async () => {
        for (let index = 0; index < 120; index += 1) {
            expect((await register({}, ANTHROPIC_IP)).status).toBe(201);
        }
    });

    test('any other address: 100 registrations an hour', async () => {
        const ip = '203.0.113.7';

        for (let index = 0; index < 100; index += 1) {
            expect((await register({}, ip)).status).toBe(201);
        }

        expect((await register({}, ip)).status).toBe(429);
        // The limit is per address
        expect((await register({}, '203.0.113.8')).status).toBe(201);
    });

    test.each([
        ['160.79.104.0', true],
        ['160.79.111.255', true],
        ['::ffff:160.79.106.1', true],
        ['160.79.103.255', false],
        ['160.79.112.0', false],
        ['160.78.104.1', false],
        ['10.0.0.1', false],
        ['::1', false],
        [undefined, false]
    ])('%s is in 160.79.104.0/21: %s', (ip, expected) => {
        expect(isAnthropicIp(ip)).toBe(expected);
    });
});

describe('reconnecting does not pile up grants', () => {
    test('a new registration of the same app (name and redirect URIs) replaces the user\'s old grant', async () => {
        const first = await connect(a, { allowWrite: true });
        const second = await connect(a);

        expect(first.client.client_id).not.toBe(second.client.client_id);

        const grants = await grantsOf(a);

        expect(grants).toHaveLength(1);
        expect(grants[0].canWrite).toBe(false);
        expect((await mcp(oauthBearer(first.tokens.access_token))).status).toBe(401);
        expect((await mcp(oauthBearer(second.tokens.access_token))).status).toBe(200);
    });

    test('claude.ai and Claude Code (other redirect URIs) keep their own grants', async () => {
        const web = await connect(a);
        const loopback = (await register({ redirect_uris: ['http://localhost:3118/callback'] })).body;
        const code = await connect(a, { client: loopback });

        expect(await grantsOf(a)).toHaveLength(2);
        expect((await mcp(oauthBearer(web.tokens.access_token))).status).toBe(200);
        expect((await mcp(oauthBearer(code.tokens.access_token))).status).toBe(200);
    });

    test('another app with the same redirect URIs but another name keeps its grant', async () => {
        await connect(a);
        await connect(a, { client: (await register({ client_name: 'Claude Desktop' })).body });

        expect(await grantsOf(a)).toHaveLength(2);
    });

    test('another user\'s grant for the same app is untouched', async () => {
        const other = await connect(b);

        await connect(a);

        expect(await grantsOf(b)).toHaveLength(1);
        expect((await mcp(oauthBearer(other.tokens.access_token))).status).toBe(200);
    });
});

describe('grants unused for 60 days expire', () => {
    test('used 61 days ago: gone from the list, its tokens and refresh stop working, disconnect is 404', async () => {
        const { client, tokens } = await connect(a);
        const [grant] = await grantsOf(a);

        await OAuthGrant.updateOne({ _id: grant.id }, { lastUsedAt: new Date(Date.now() - 61 * DAY_MS) });

        expect(await grantsOf(a)).toEqual([]);
        expect((await mcp(oauthBearer(tokens.access_token))).status).toBe(401);
        expect((await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token })).body.error)
            .toBe('invalid_grant');
        expect((await request(app).delete(`/api/oauth/grants/${grant.id}`).set(bearer(a))).status).toBe(404);
    });

    test('never used and created 61 days ago: expired', async () => {
        await connect(a);
        await OAuthGrant.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 61 * DAY_MS), lastUsedAt: null } });

        expect(await grantsOf(a)).toEqual([]);
    });

    test('used 59 days ago: still connected', async () => {
        const { tokens } = await connect(a);

        await OAuthGrant.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 90 * DAY_MS), lastUsedAt: new Date(Date.now() - 59 * DAY_MS) } });

        expect(await grantsOf(a)).toHaveLength(1);
        expect((await mcp(oauthBearer(tokens.access_token))).status).toBe(200);
    });

    test('a refresh counts as use', async () => {
        const { client, tokens } = await connect(a);
        const stale = new Date(Date.now() - 30 * DAY_MS);

        await OAuthGrant.updateMany({}, { lastUsedAt: stale });
        await token({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });

        expect((await OAuthGrant.findOne({})).lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
    });
});

describe('authorize page hardening', () => {
    let client;
    let pkce;
    let params;

    beforeEach(async () => {
        client = (await register()).body;
        pkce = pkcePair();
        params = authorizationParams(client, pkce);
    });

    test('the sign-in page posts only to itself', async () => {
        const res = await request(app).get('/oauth/authorize').set('X-Forwarded-For', nextIp()).query(params);

        expect(res.headers['content-security-policy']).toContain("form-action 'self'");
        expect(res.headers['content-security-policy']).not.toContain('claude.ai');
    });

    test('the consent page posts to itself and lets its answer redirect to the client\'s origin only', async () => {
        const res = await signIn(params, { email: a.email });

        expect(nonceFrom(res.text)).toEqual(expect.any(String));
        expect(res.headers['content-security-policy']).toMatch(/form-action 'self' https:\/\/claude\.ai$/);
    });

    test.each([
        ['plain PKCE', { code_challenge_method: 'plain' }, 'code_challenge_method'],
        ['no challenge', { code_challenge: undefined }, 'code_challenge'],
        ['another response_type', { response_type: 'token' }, 'response_type']
    ])('%s: the error redirect has a short description, not validation JSON', async (label, overrides, field) => {
        const bad = { ...params, ...overrides };

        for (const key of Object.keys(bad)) {
            if (bad[key] === undefined) {
                delete bad[key];
            }
        }

        const res = await request(app).get('/oauth/authorize').set('X-Forwarded-For', nextIp()).query(bad);
        const location = new URL(res.headers.location);
        const description = location.searchParams.get('error_description');

        expect(res.status).toBe(302);
        expect(location.searchParams.get('error')).toBe('invalid_request');
        expect(location.searchParams.get('state')).toBe('state-123');
        expect(description).toBe(`Invalid or missing: ${field}`);
    });
});

describe('/mcp reads the body only after the token', () => {
    const big = { ...INITIALIZE, params: { ...INITIALIZE.params, padding: 'x'.repeat(300 * 1024) } };

    test('a large body without a token: 401, not 413', async () => {
        const res = await mcp({}, big);

        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    });

    test('a body over 256 KB with a token: 413 as a JSON-RPC error', async () => {
        const { tokens } = await connect(a);
        const res = await mcp(oauthBearer(tokens.access_token), big);

        expect(res.status).toBe(413);
        expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
    });

    test('a body under 256 KB with a token: served', async () => {
        const { tokens } = await connect(a);
        const res = await mcp(oauthBearer(tokens.access_token), {
            ...INITIALIZE,
            params: { ...INITIALIZE.params, padding: 'x'.repeat(200 * 1024) }
        });

        expect(res.status).toBe(200);
    });
});
