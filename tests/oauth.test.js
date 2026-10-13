const request = require('supertest');
const app = require('../app');
const OAuthClient = require('../models/OAuthClient');
const OAuthCode = require('../models/OAuthCode');
const OAuthGrant = require('../models/OAuthGrant');
const OAuthToken = require('../models/OAuthToken');
const loginGuard = require('../utils/loginGuard');
const { hashSecret } = require('../services/oauthProvider');
const { seedUser, seedFund, seedCategory, bearer, botHeaders } = require('./helpers');
const {
    CLAUDE_CALLBACK,
    RESOURCE,
    nextIp,
    pkcePair,
    register,
    authorizationParams,
    nonceFrom,
    signIn,
    consent,
    token,
    connect,
    oauthBearer
} = require('./oauth.helpers');

const PRM_URL = 'https://api.wannatrack.shataev.com/.well-known/oauth-protected-resource/mcp';

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

let a;
let b;

beforeEach(async () => {
    loginGuard.reset();

    a = await seedUser({ defaultCurrency: 'THB' });
    b = await seedUser({ defaultCurrency: 'THB' });
});

describe('discovery', () => {
    test('/mcp without a token: 401 pointing at the protected resource metadata', async () => {
        const res = await mcp();

        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toBe(
            `Bearer resource_metadata="${PRM_URL}", scope="expenses.read expenses.write offline_access"`
        );
    });

    test.each([
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-protected-resource'
    ])('protected resource metadata at %s', async (path) => {
        const res = await request(app).get(path);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            resource: RESOURCE,
            authorization_servers: ['https://api.wannatrack.shataev.com'],
            scopes_supported: ['expenses.read', 'expenses.write', 'offline_access']
        });
    });

    test('authorization server metadata: DCR, S256, public clients, no CIMD', async () => {
        const res = await request(app).get('/.well-known/oauth-authorization-server');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            issuer: 'https://api.wannatrack.shataev.com',
            authorization_endpoint: 'https://api.wannatrack.shataev.com/oauth/authorize',
            token_endpoint: 'https://api.wannatrack.shataev.com/oauth/token',
            registration_endpoint: 'https://api.wannatrack.shataev.com/oauth/register',
            revocation_endpoint: 'https://api.wannatrack.shataev.com/oauth/revoke',
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['expenses.read', 'expenses.write', 'offline_access']
        });
        expect(res.body).not.toHaveProperty('client_id_metadata_document_supported');
    });
});

describe('dynamic client registration', () => {
    test.each([
        ['claude.ai', 'https://claude.ai/api/mcp/auth_callback'],
        ['claude.com', 'https://claude.com/api/mcp/auth_callback'],
        ['Claude Code on localhost', 'http://localhost:53682/callback'],
        ['Claude Code on 127.0.0.1', 'http://127.0.0.1:3118/callback']
    ])('%s is registered as a public client and stored', async (label, redirectUri) => {
        const res = await register({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_basic' });

        expect(res.status).toBe(201);
        expect(res.body.client_id).toEqual(expect.any(String));
        expect(res.body.token_endpoint_auth_method).toBe('none');
        expect(res.body).not.toHaveProperty('client_secret');
        expect(await OAuthClient.exists({ clientId: res.body.client_id })).toBeTruthy();
    });

    test.each([
        ['another host', 'https://evil.example/api/mcp/auth_callback'],
        ['claude.ai with another path', 'https://claude.ai/callback'],
        ['claude.ai over http', 'http://claude.ai/api/mcp/auth_callback'],
        ['a loopback with another path', 'http://localhost:3000/steal'],
        ['a loopback with a query', 'http://127.0.0.1:3000/callback?x=1'],
        ['a lookalike loopback host', 'http://localhost.evil.example/callback']
    ])('%s is rejected with invalid_redirect_uri', async (label, redirectUri) => {
        const res = await register({ redirect_uris: [redirectUri] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_redirect_uri');
        expect(await OAuthClient.countDocuments()).toBe(0);
    });

    test('one foreign redirect among allowed ones is rejected', async () => {
        const res = await register({ redirect_uris: [CLAUDE_CALLBACK, 'https://evil.example/cb'] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_redirect_uri');
    });
});

describe('authorize', () => {
    let client;
    let pkce;
    let params;

    beforeEach(async () => {
        client = (await register()).body;
        pkce = pkcePair();
        params = authorizationParams(client, pkce);
    });

    test('GET shows the sign-in page naming the client, and cannot be framed', async () => {
        const res = await request(app).get('/oauth/authorize').set('X-Forwarded-For', nextIp()).query(params);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.text).toContain('Claude');
        expect(res.text).toContain('name="password"');
    });

    test('the client name is escaped on the page', async () => {
        const evil = (await register({ client_name: '<script>alert(1)</script>' })).body;
        const res = await request(app)
            .get('/oauth/authorize')
            .set('X-Forwarded-For', nextIp())
            .query(authorizationParams(evil, pkce));

        expect(res.text).not.toContain('<script>alert(1)</script>');
        expect(res.text).toContain('&lt;script&gt;');
    });

    test('wrong password: the sign-in page again, no consent nonce', async () => {
        const res = await signIn(params, { email: a.email, password: 'wrong' });

        expect(res.status).toBe(401);
        expect(res.text).toContain('Wrong email or password');
        expect(nonceFrom(res.text)).toBeNull();
        expect(await OAuthCode.countDocuments()).toBe(0);
    });

    test('unknown email: the same answer as a wrong password', async () => {
        const res = await signIn(params, { email: 'nobody@example.test' });

        expect(res.status).toBe(401);
        expect(res.text).toContain('Wrong email or password');
    });

    test('correct sign-in: the consent page names the client and the redirect hostname', async () => {
        const res = await signIn(params, { email: a.email });

        expect(res.status).toBe(200);
        expect(res.text).toContain('claude.ai');
        expect(res.text).toContain('Allow adding expenses and changing the active tag');
        expect(nonceFrom(res.text)).toEqual(expect.any(String));
    });

    test('brute force: after 10 failures from one IP even the right password is refused', async () => {
        const ip = nextIp();

        for (let attempt = 0; attempt < 10; attempt += 1) {
            expect((await signIn(params, { email: a.email, password: `wrong-${attempt}`, ip })).status).toBe(401);
        }

        const locked = await signIn(params, { email: a.email, ip });

        expect(locked.status).toBe(429);
        expect(nonceFrom(locked.text)).toBeNull();

        // Another address and another account are not affected
        expect((await signIn(params, { email: b.email, ip: nextIp() })).status).toBe(200);
    });

    test('brute force: after 10 failures for one email, any IP is refused for it', async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await signIn(params, { email: a.email, password: `wrong-${attempt}`, ip: nextIp() });
        }

        const locked = await signIn(params, { email: a.email, ip: nextIp() });

        expect(locked.status).toBe(429);
    });

    test('consent without write: a read-only grant', async () => {
        const { tokens } = await connect(a, { client });

        expect(tokens.scope.split(' ').sort()).toEqual(['expenses.read', 'offline_access']);

        const grant = await OAuthGrant.findOne({ user: a._id });

        expect(grant.scopes).toEqual(['expenses.read']);
    });

    test('consent with write: read and write', async () => {
        const { tokens } = await connect(a, { client, allowWrite: true });

        expect(tokens.scope.split(' ').sort()).toEqual(['expenses.read', 'expenses.write', 'offline_access']);
    });

    test('a client asking for read only is not offered write, even if the form says so', async () => {
        const readParams = authorizationParams(client, pkce, { scope: 'expenses.read offline_access' });
        const signedIn = await signIn(readParams, { email: a.email });

        expect(signedIn.text).not.toContain('allow_write');

        const approved = await consent(readParams, nonceFrom(signedIn.text), { allowWrite: true });
        const code = new URL(approved.headers.location).searchParams.get('code');

        expect((await OAuthCode.findOne({ hash: hashSecret(code) })).scopes).not.toContain('expenses.write');
    });

    test('deny: back to the client with access_denied and the state', async () => {
        const signedIn = await signIn(params, { email: a.email });
        const res = await consent(params, nonceFrom(signedIn.text), { decision: 'deny' });

        expect(res.status).toBe(302);

        const location = new URL(res.headers.location);

        expect(location.origin + location.pathname).toBe(CLAUDE_CALLBACK);
        expect(location.searchParams.get('error')).toBe('access_denied');
        expect(location.searchParams.get('state')).toBe('state-123');
        expect(await OAuthGrant.countDocuments()).toBe(0);
    });

    test('allow: back to the client with a code and the state', async () => {
        const signedIn = await signIn(params, { email: a.email });
        const res = await consent(params, nonceFrom(signedIn.text));

        expect(res.status).toBe(302);

        const location = new URL(res.headers.location);

        expect(location.origin + location.pathname).toBe(CLAUDE_CALLBACK);
        expect(location.searchParams.get('code')).toEqual(expect.any(String));
        expect(location.searchParams.get('state')).toBe('state-123');
    });

    test('consent without the server-issued nonce is refused (no CSRF)', async () => {
        const res = await consent(params, undefined);

        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
        expect(await OAuthGrant.countDocuments()).toBe(0);
    });

    test('a made-up nonce is refused', async () => {
        const res = await consent(params, 'made-up');

        expect(res.status).toBe(400);
        expect(await OAuthGrant.countDocuments()).toBe(0);
    });

    test('a consent nonce works once', async () => {
        const signedIn = await signIn(params, { email: a.email });
        const nonce = nonceFrom(signedIn.text);

        expect((await consent(params, nonce)).status).toBe(302);
        expect((await consent(params, nonce)).status).toBe(400);
        expect(await OAuthGrant.countDocuments()).toBe(1);
    });

    test('a nonce issued for another request (other challenge) is refused', async () => {
        const signedIn = await signIn(params, { email: a.email });
        const other = authorizationParams(client, pkcePair());

        expect((await consent(other, nonceFrom(signedIn.text))).status).toBe(400);
    });

    test('an expired nonce is refused', async () => {
        const signedIn = await signIn(params, { email: a.email });

        await OAuthCode.updateMany({ kind: 'consent' }, { expiresAt: new Date(Date.now() - 1000) });

        expect((await consent(params, nonceFrom(signedIn.text))).status).toBe(400);
    });

    test.each([
        ['plain', { code_challenge_method: 'plain' }],
        ['missing method', { code_challenge_method: undefined }],
        ['missing challenge', { code_challenge: undefined }]
    ])('PKCE %s is rejected', async (label, overrides) => {
        const bad = authorizationParams(client, pkce, overrides);

        for (const key of Object.keys(bad)) {
            if (bad[key] === undefined) {
                delete bad[key];
            }
        }

        const res = await signIn(bad, { email: a.email });

        expect(res.status).toBe(302);
        expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_request');
        expect(await OAuthCode.countDocuments()).toBe(0);
    });

    test('an unregistered redirect URI is a direct 400, never a redirect', async () => {
        const res = await request(app)
            .get('/oauth/authorize')
            .set('X-Forwarded-For', nextIp())
            .query({ ...params, redirect_uri: 'https://evil.example/cb' });

        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
    });

    test('an unknown client is a direct 400', async () => {
        const res = await request(app)
            .get('/oauth/authorize')
            .set('X-Forwarded-For', nextIp())
            .query({ ...params, client_id: 'unknown' });

        expect(res.status).toBe(400);
    });

    test('another resource is refused with invalid_target', async () => {
        const res = await signIn({ ...params, resource: 'https://other.example/mcp' }, { email: a.email });

        expect(res.status).toBe(302);
        expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_target');
    });

    test('Claude Code: a loopback client registered on one port authorizes on another', async () => {
        const loopback = (await register({ redirect_uris: ['http://127.0.0.1:3118/callback'] })).body;
        const loopbackParams = authorizationParams(loopback, pkce, { redirect_uri: 'http://127.0.0.1:49152/callback' });
        const signedIn = await signIn(loopbackParams, { email: a.email });

        expect(signedIn.status).toBe(200);
        expect(signedIn.text).toContain('127.0.0.1');

        const approved = await consent(loopbackParams, nonceFrom(signedIn.text));

        expect(approved.headers.location.startsWith('http://127.0.0.1:49152/callback?')).toBe(true);
    });
});

describe('token endpoint', () => {
    let client;
    let pkce;
    let params;
    let code;

    const authorizeOnce = async () => {
        const signedIn = await signIn(params, { email: a.email });
        const approved = await consent(params, nonceFrom(signedIn.text), { allowWrite: true });

        return new URL(approved.headers.location).searchParams.get('code');
    };

    const exchange = (overrides = {}) => token({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: params.redirect_uri,
        resource: RESOURCE,
        ...overrides
    });

    beforeEach(async () => {
        client = (await register()).body;
        pkce = pkcePair();
        params = authorizationParams(client, pkce);
        code = await authorizeOnce();
    });

    test('form-encoded exchange: opaque tokens for 1 hour, stored only as hashes', async () => {
        const res = await exchange();

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
        expect(res.body.access_token).toEqual(expect.any(String));
        expect(res.body.refresh_token).toEqual(expect.any(String));
        expect(res.body.access_token.split('.')).toHaveLength(1);

        const stored = await OAuthToken.find().lean();

        expect(stored).toHaveLength(2);
        expect(JSON.stringify(stored)).not.toContain(res.body.access_token);
        expect(JSON.stringify(stored)).not.toContain(res.body.refresh_token);
        expect(await OAuthToken.exists({ hash: hashSecret(res.body.access_token), kind: 'access' })).toBeTruthy();

        const access = stored.find(item => item.kind === 'access');
        const refresh = stored.find(item => item.kind === 'refresh');

        expect(access.expiresAt - access.createdAt).toBeGreaterThan(3590 * 1000);
        expect(access.expiresAt - access.createdAt).toBeLessThanOrEqual(3600 * 1000 + 1000);
        expect(refresh.expiresAt - refresh.createdAt).toBeGreaterThan(29 * 24 * 3600 * 1000);
        expect(String(access.user)).toBe(String(a._id));
        expect(access.clientId).toBe(client.client_id);
    });

    test('no offline_access: no refresh token', async () => {
        const readParams = authorizationParams(client, pkce, { scope: 'expenses.read' });
        const signedIn = await signIn(readParams, { email: a.email });
        const approved = await consent(readParams, nonceFrom(signedIn.text));
        const res = await token({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: new URL(approved.headers.location).searchParams.get('code'),
            code_verifier: pkce.verifier,
            redirect_uri: readParams.redirect_uri
        });

        expect(res.status).toBe(200);
        expect(res.body.refresh_token).toBeUndefined();
    });

    test('wrong code_verifier: invalid_grant, no token', async () => {
        const res = await exchange({ code_verifier: pkcePair().verifier });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
        expect(await OAuthToken.countDocuments()).toBe(0);
    });

    test('a code works once; reusing it revokes what it granted', async () => {
        const first = await exchange();

        expect(first.status).toBe(200);

        const second = await exchange();

        expect(second.status).toBe(400);
        expect(second.body.error).toBe('invalid_grant');
        expect((await mcp(oauthBearer(first.body.access_token))).status).toBe(401);
    });

    test('an expired code is refused', async () => {
        await OAuthCode.updateMany({ kind: 'code' }, { expiresAt: new Date(Date.now() - 1000) });

        const res = await exchange();

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    test('codes expire 5 minutes after they are issued', async () => {
        const stored = await OAuthCode.findOne({ kind: 'code' });

        expect(stored.expiresAt - stored.createdAt).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
        expect(stored.expiresAt - stored.createdAt).toBeGreaterThan(4 * 60 * 1000);
    });

    test('a code is bound to its client', async () => {
        const other = (await register()).body;
        const res = await exchange({ client_id: other.client_id });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    test('a code is bound to its redirect URI', async () => {
        const res = await exchange({ redirect_uri: 'https://claude.com/api/mcp/auth_callback' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
    });

    test('an unknown client is 401 invalid_client, so Claude registers again', async () => {
        const res = await exchange({ client_id: 'deleted-client' });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    test('a deleted client is 401 invalid_client', async () => {
        await OAuthClient.deleteMany({});

        const res = await exchange();

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_client');
    });

    test('JSON bodies are not how the token endpoint is called; form bodies are', async () => {
        const res = await request(app)
            .post('/oauth/token')
            .set('X-Forwarded-For', nextIp())
            .type('form')
            .send(`grant_type=authorization_code&client_id=${encodeURIComponent(client.client_id)}&code=${encodeURIComponent(code)}&code_verifier=${encodeURIComponent(pkce.verifier)}`);

        expect(res.status).toBe(200);
    });

    describe('refresh', () => {
        let tokens;

        const refresh = (refreshToken, overrides = {}) => token({
            grant_type: 'refresh_token',
            client_id: client.client_id,
            refresh_token: refreshToken,
            ...overrides
        });

        beforeEach(async () => {
            tokens = (await exchange()).body;
        });

        test('rotates: a new pair, the old refresh token stops working', async () => {
            const rotated = await refresh(tokens.refresh_token);

            expect(rotated.status).toBe(200);
            expect(rotated.body.refresh_token).toEqual(expect.any(String));
            expect(rotated.body.refresh_token).not.toBe(tokens.refresh_token);
            expect(rotated.body.access_token).not.toBe(tokens.access_token);
            expect(rotated.body.scope.split(' ').sort()).toEqual(['expenses.read', 'expenses.write', 'offline_access']);
            expect((await mcp(oauthBearer(rotated.body.access_token))).status).toBe(200);

            const again = await refresh(tokens.refresh_token);

            expect(again.status).toBe(400);
            expect(again.body.error).toBe('invalid_grant');
        });

        test('reusing a rotated refresh token revokes the whole grant', async () => {
            const rotated = (await refresh(tokens.refresh_token)).body;

            await refresh(tokens.refresh_token);

            expect((await OAuthGrant.findOne({ user: a._id })).revokedAt).toEqual(expect.any(Date));
            expect((await mcp(oauthBearer(rotated.access_token))).status).toBe(401);
            expect((await refresh(rotated.refresh_token)).body.error).toBe('invalid_grant');
        });

        test('an unknown refresh token is invalid_grant', async () => {
            const res = await refresh('made-up');

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_grant');
        });

        test('an expired refresh token is invalid_grant', async () => {
            await OAuthToken.updateMany({ kind: 'refresh' }, { expiresAt: new Date(Date.now() - 1000) });

            const res = await refresh(tokens.refresh_token);

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_grant');
        });

        test('another client cannot use the refresh token', async () => {
            const other = (await register()).body;
            const res = await refresh(tokens.refresh_token, { client_id: other.client_id });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_grant');
        });

        test('a refresh cannot widen the scopes', async () => {
            const readOnly = await connect(b);
            const res = await token({
                grant_type: 'refresh_token',
                client_id: readOnly.client.client_id,
                refresh_token: readOnly.tokens.refresh_token,
                scope: 'expenses.read expenses.write offline_access'
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_scope');
        });
    });
});

describe('/mcp accepts only OAuth access tokens', () => {
    test('a valid access token: 200', async () => {
        const { tokens } = await connect(a);

        expect((await mcp(oauthBearer(tokens.access_token))).status).toBe(200);
    });

    test('an expired access token: 401 with the discovery header', async () => {
        const { tokens } = await connect(a);

        await OAuthToken.updateMany({ kind: 'access' }, { expiresAt: new Date(Date.now() - 1000) });

        const res = await mcp(oauthBearer(tokens.access_token));

        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toContain(`resource_metadata="${PRM_URL}"`);
    });

    test('a made-up token: 401', async () => {
        expect((await mcp(oauthBearer('made-up'))).status).toBe(401);
    });

    test('the web app\'s JWT: 401', async () => {
        expect((await mcp(bearer(a))).status).toBe(401);
    });

    test('the bot secret with a linked Telegram id: 401', async () => {
        const linked = await seedUser({ telegramId: '777' });

        expect((await mcp(botHeaders(linked.telegramId))).status).toBe(401);
    });

    test('a valid access token plus the bot secret: 401', async () => {
        const { tokens } = await connect(a);

        expect((await mcp({ ...oauthBearer(tokens.access_token), ...botHeaders('777') })).status).toBe(401);
    });

    test('a refresh token is not an access token: 401', async () => {
        const { tokens } = await connect(a);

        expect((await mcp(oauthBearer(tokens.refresh_token))).status).toBe(401);
    });

    test('lastUsedAt is set on the grant, at most once a minute', async () => {
        const { tokens } = await connect(a);

        await mcp(oauthBearer(tokens.access_token));

        const first = (await OAuthGrant.findOne({ user: a._id })).lastUsedAt;

        expect(first).toEqual(expect.any(Date));

        await mcp(oauthBearer(tokens.access_token));

        expect((await OAuthGrant.findOne({ user: a._id })).lastUsedAt).toEqual(first);

        const stale = new Date(Date.now() - 61 * 1000);

        await OAuthGrant.updateOne({ user: a._id }, { lastUsedAt: stale });
        await mcp(oauthBearer(tokens.access_token));

        expect((await OAuthGrant.findOne({ user: a._id })).lastUsedAt.getTime()).toBeGreaterThan(stale.getTime() + 30 * 1000);
    });
});

describe('OAuth access tokens are rejected on every REST route', () => {
    let accessToken;
    let fund;
    let category;

    beforeEach(async () => {
        fund = await seedFund(a, { currency: 'THB' });
        category = await seedCategory(a);
        accessToken = (await connect(a, { allowWrite: true })).tokens.access_token;
    });

    test.each([
        ['get', '/api/me', () => '/api/me'],
        ['get', '/api/category', () => '/api/category'],
        ['get', '/api/funds', () => '/api/funds'],
        ['get', '/api/funds/:id', () => `/api/funds/${fund._id}`],
        ['get', '/api/costs', () => '/api/costs?dateFrom=2026-01-01&dateTo=2027-01-01'],
        ['get', '/api/tags', () => '/api/tags'],
        ['get', '/api/analytics/summary', () => '/api/analytics/summary?dateFrom=2026-10-01&dateTo=2026-11-01'],
        ['get', '/api/analytics/monthly', () => '/api/analytics/monthly'],
        ['post', '/api/cost', () => '/api/cost'],
        ['put', '/api/me/active-tag', () => '/api/me/active-tag'],
        ['get', '/api/oauth/grants', () => '/api/oauth/grants'],
        ['get', '/api/telegram/telegram-binding-link', () => '/api/telegram/telegram-binding-link']
    ])('%s %s → 401', async (method, label, path) => {
        const res = await request(app)[method](path())
            .set(oauthBearer(accessToken))
            .send({ amount: 10, category: String(category._id), fundId: String(fund._id), tag: 'x' });

        expect(res.status).toBe(401);
    });

    test('nothing was written', async () => {
        await request(app).post('/api/cost').set(oauthBearer(accessToken))
            .send({ amount: 10, category: String(category._id), fundId: String(fund._id) });

        const Fund = require('../models/Fund');

        expect((await Fund.findById(fund._id)).currentBalance).toBe(1000);
    });
});

describe('revocation (RFC 7009)', () => {
    let connected;

    const revoke = (tokenValue, clientId = connected.client.client_id) => request(app)
        .post('/oauth/revoke')
        .set('X-Forwarded-For', nextIp())
        .type('form')
        .send({ token: tokenValue, client_id: clientId });

    beforeEach(async () => {
        connected = await connect(a);
    });

    test('revoking the access token: /mcp 401', async () => {
        const res = await revoke(connected.tokens.access_token);

        expect(res.status).toBe(200);
        expect((await mcp(oauthBearer(connected.tokens.access_token))).status).toBe(401);
    });

    test('revoking the refresh token revokes the grant and its access token', async () => {
        await revoke(connected.tokens.refresh_token);

        expect((await mcp(oauthBearer(connected.tokens.access_token))).status).toBe(401);
        expect((await token({
            grant_type: 'refresh_token',
            client_id: connected.client.client_id,
            refresh_token: connected.tokens.refresh_token
        })).body.error).toBe('invalid_grant');
    });

    test('an unknown token is not an error', async () => {
        expect((await revoke('made-up')).status).toBe(200);
    });

    test('another client cannot revoke the token', async () => {
        const other = (await register()).body;

        await revoke(connected.tokens.access_token, other.client_id);

        expect((await mcp(oauthBearer(connected.tokens.access_token))).status).toBe(200);
    });
});

describe('connected apps (web API)', () => {
    test('lists the caller\'s active grants only', async () => {
        await connect(a, { allowWrite: true });
        await connect(b);

        const res = await request(app).get('/api/oauth/grants').set(bearer(a));

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({
            id: expect.any(String),
            clientName: 'Claude',
            scopes: ['expenses.read', 'expenses.write'],
            canWrite: true,
            lastUsedAt: null
        });
        expect(res.body[0].createdAt).toEqual(expect.any(String));
    });

    test('connecting the same client again replaces the grant', async () => {
        const first = await connect(a, { allowWrite: true });

        await connect(a, { client: first.client });

        const res = await request(app).get('/api/oauth/grants').set(bearer(a));

        expect(res.body).toHaveLength(1);
        expect(res.body[0].canWrite).toBe(false);
        expect((await mcp(oauthBearer(first.tokens.access_token))).status).toBe(401);
    });

    test('disconnect revokes the grant and all its tokens', async () => {
        const { tokens, client } = await connect(a);
        const [grant] = (await request(app).get('/api/oauth/grants').set(bearer(a))).body;

        const res = await request(app).delete(`/api/oauth/grants/${grant.id}`).set(bearer(a));

        expect(res.status).toBe(204);
        expect((await mcp(oauthBearer(tokens.access_token))).status).toBe(401);
        expect((await token({
            grant_type: 'refresh_token',
            client_id: client.client_id,
            refresh_token: tokens.refresh_token
        })).body.error).toBe('invalid_grant');
        expect((await request(app).get('/api/oauth/grants').set(bearer(a))).body).toEqual([]);
    });

    test('another user\'s grant id: 404 and the grant keeps working', async () => {
        const { tokens } = await connect(b);
        const [grant] = (await request(app).get('/api/oauth/grants').set(bearer(b))).body;

        const res = await request(app).delete(`/api/oauth/grants/${grant.id}`).set(bearer(a));

        expect(res.status).toBe(404);
        expect((await mcp(oauthBearer(tokens.access_token))).status).toBe(200);
    });

    test('an invalid or already revoked id: 404', async () => {
        await connect(a);

        const [grant] = (await request(app).get('/api/oauth/grants').set(bearer(a))).body;

        expect((await request(app).delete('/api/oauth/grants/not-an-id').set(bearer(a))).status).toBe(404);
        expect((await request(app).delete(`/api/oauth/grants/${grant.id}`).set(bearer(a))).status).toBe(204);
        expect((await request(app).delete(`/api/oauth/grants/${grant.id}`).set(bearer(a))).status).toBe(404);
    });

    test('without credentials: 401; the bot cannot reach it', async () => {
        const linked = await seedUser({ telegramId: '555' });

        expect((await request(app).get('/api/oauth/grants')).status).toBe(401);
        expect((await request(app).get('/api/oauth/grants').set(botHeaders(linked.telegramId))).status).toBe(403);
    });
});
