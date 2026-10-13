const crypto = require('crypto');
const request = require('supertest');
const app = require('../app');
const { TEST_PASSWORD } = require('./helpers');

// A test OAuth client walking the flow the way Claude does: DCR, PKCE S256, sign in, consent, token exchange.
// Every call comes from its own client address (X-Forwarded-For), so the per-IP limits of one test never
// reach another.

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = 'https://api.wannatrack.shataev.com/mcp';
const ALL_SCOPES = 'expenses.read expenses.write offline_access';

let ipCounter = 0;

const nextIp = () => {
    ipCounter += 1;

    return `198.51.100.${ipCounter % 250 + 1}`;
};

const pkcePair = () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    return { verifier, challenge };
};

const register = (body = {}, ip = nextIp()) => request(app)
    .post('/oauth/register')
    .set('X-Forwarded-For', ip)
    .send({
        client_name: 'Claude',
        redirect_uris: [CLAUDE_CALLBACK],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...body
    });

const authorizationParams = (client, pkce, overrides = {}) => ({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    scope: ALL_SCOPES,
    state: 'state-123',
    resource: RESOURCE,
    ...overrides
});

const nonceFrom = (html) => {
    const match = /name="nonce" value="([^"]+)"/.exec(html);

    return match ? match[1] : null;
};

const signIn = (params, { email, password = TEST_PASSWORD, ip = nextIp() }) => request(app)
    .post('/oauth/authorize')
    .set('X-Forwarded-For', ip)
    .type('form')
    .send({ ...params, step: 'signin', email, password });

const consent = (params, nonce, { allowWrite = false, decision = 'allow', ip = nextIp() } = {}) => request(app)
    .post('/oauth/authorize')
    .set('X-Forwarded-For', ip)
    .type('form')
    .send({ ...params, step: 'consent', nonce, decision, ...(allowWrite ? { allow_write: 'on' } : {}) });

const token = (body, ip = nextIp()) => request(app)
    .post('/oauth/token')
    .set('X-Forwarded-For', ip)
    .type('form')
    .send(body);

/**
 * The whole flow for `user`: register (unless a client is given), sign in, consent, exchange the code.
 * Resolves to { client, tokens, code, pkce, params }.
 */
const connect = async (user, { allowWrite = false, client, scope = ALL_SCOPES } = {}) => {
    const registered = client ?? (await register()).body;
    const pkce = pkcePair();
    const params = authorizationParams(registered, pkce, { scope });

    const signedIn = await signIn(params, { email: user.email });

    if (signedIn.status !== 200) {
        throw new Error(`sign-in failed: ${signedIn.status}`);
    }

    const approved = await consent(params, nonceFrom(signedIn.text), { allowWrite });

    if (approved.status !== 302) {
        throw new Error(`consent failed: ${approved.status} ${approved.text}`);
    }

    const code = new URL(approved.headers.location).searchParams.get('code');
    const exchanged = await token({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: params.redirect_uri,
        resource: RESOURCE
    });

    if (exchanged.status !== 200) {
        throw new Error(`token exchange failed: ${exchanged.status} ${exchanged.text}`);
    }

    return { client: registered, tokens: exchanged.body, code, pkce, params };
};

const oauthBearer = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });

module.exports = {
    CLAUDE_CALLBACK,
    RESOURCE,
    ALL_SCOPES,
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
};
