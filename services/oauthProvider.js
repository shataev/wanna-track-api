const crypto = require('crypto');
const User = require('../models/User');
const OAuthClient = require('../models/OAuthClient');
const OAuthGrant = require('../models/OAuthGrant');
const OAuthCode = require('../models/OAuthCode');
const OAuthToken = require('../models/OAuthToken');
const {
    AccessDeniedError,
    CustomOAuthError,
    InvalidGrantError,
    InvalidScopeError,
    InvalidTargetError,
    InvalidTokenError
} = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { passwordMatches, toAuthUser } = require('../utils/auth.utils');
const { parseObjectId } = require('../utils/id.utils');
const loginGuard = require('../utils/loginGuard');
const { signInPage, consentPage, errorPage } = require('./oauthPages');
const {
    MCP_RESOURCE,
    SCOPE_READ,
    SCOPE_WRITE,
    SCOPE_OFFLINE,
    isAllowedRedirectUri,
    ACCESS_TOKEN_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS,
    AUTHORIZATION_CODE_TTL_SECONDS,
    CONSENT_TTL_SECONDS
} = require('../utils/oauth.config');

/**
 * The OAuth authorization server behind /oauth/*, in the shape the MCP SDK's handlers expect
 * (OAuthServerProvider). The SDK's handlers parse and validate the requests, check the client and the
 * redirect URI, and verify PKCE; this module stores clients, grants, codes and tokens in MongoDB.
 *
 * Every secret (consent nonce, authorization code, access and refresh token) is random, handed out once
 * and stored only as its sha256.
 */

const MAX_CLIENT_NAME_LENGTH = 100;
const LAST_USED_RESOLUTION_MS = 60 * 1000;

const newSecret = () => crypto.randomBytes(32).toString('base64url');

const hashSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');

const secondsFromNow = (seconds) => new Date(Date.now() + seconds * 1000);

// A resource URL as it is compared: no fragment, no trailing slash
const comparableResource = (value) => String(value).split('#')[0].replace(/\/$/, '');

const isOurResource = (resource) => resource === undefined || comparableResource(resource) === comparableResource(MCP_RESOURCE);

const sanitizeClientName = (value) => typeof value === 'string' && value.trim()
    ? value.trim().slice(0, MAX_CLIENT_NAME_LENGTH)
    : null;

// Revoke a grant and every token issued under it
const revokeGrant = async (grantId) => {
    const now = new Date();

    await OAuthGrant.updateOne({ _id: grantId, revokedAt: null }, { revokedAt: now });
    await OAuthToken.updateMany({ grant: grantId, revokedAt: null }, { revokedAt: now });
};

const isActiveGrant = (grant) => Boolean(grant) && grant.revokedAt === null;

// ---------- Clients (dynamic client registration) ----------

const clientsStore = {
    async getClient(clientId) {
        if (typeof clientId !== 'string') {
            return undefined;
        }

        const client = await OAuthClient.findOne({ clientId });

        return client ? client.metadata : undefined;
    },

    // Public clients only, and only with the redirect URIs of the Claude apps
    async registerClient(client) {
        const redirectUris = client.redirect_uris ?? [];

        if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
            throw new CustomOAuthError('invalid_redirect_uri', 'Only the redirect URIs of the Claude apps can be registered');
        }

        const { client_secret, client_secret_expires_at, ...rest } = client;

        const metadata = {
            ...rest,
            client_name: sanitizeClientName(client.client_name) ?? undefined,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code']
        };

        await OAuthClient.create({
            clientId: metadata.client_id,
            clientName: metadata.client_name ?? null,
            redirectUris,
            metadata
        });

        return metadata;
    }
};

// ---------- Authorization (the sign-in and consent pages) ----------

const sendPage = (res, status, html) => {
    res.status(status)
        .set('Content-Type', 'text/html; charset=utf-8')
        .set('X-Frame-Options', 'DENY')
        .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
        .send(html);
};

// The scopes of an authorization request: unknown ones are ignored. Without a scope, read and write are offered
const parseRequestedScopes = (scopes) => {
    const requested = (scopes ?? []).filter(Boolean);

    return {
        offerWrite: requested.length === 0 || requested.includes(SCOPE_WRITE),
        offline: requested.includes(SCOPE_OFFLINE)
    };
};

// The request a consent nonce or a code was issued for, to compare with the request that presents it
const requestBinding = (client, params) => ({
    clientId: client.client_id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    state: params.state ?? null,
    resource: MCP_RESOURCE
});

const sameBinding = (stored, expected) => Object.keys(expected).every(key => stored[key] === expected[key]);

const showSignIn = (res, client, req, status = 200, error = null, email = '') =>
    sendPage(res, status, signInPage({ client, params: req.method === 'POST' ? req.body : req.query, error, email }));

const handleSignIn = async (client, params, req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const ip = req.ip;

    if (loginGuard.isLocked(ip, email)) {
        return showSignIn(res, client, req, 429, 'Too many failed attempts. Try again in 15 minutes.', email);
    }

    const user = email ? await User.findOne({ email }) : null;

    if (!user || !passwordMatches(user, password)) {
        loginGuard.recordFailure(ip, email);

        return showSignIn(res, client, req, 401, 'Wrong email or password', email);
    }

    const nonce = newSecret();
    const { offerWrite, offline } = parseRequestedScopes(params.scopes);

    await OAuthCode.create({
        kind: 'consent',
        hash: hashSecret(nonce),
        user: user._id,
        ...requestBinding(client, params),
        scopes: [SCOPE_READ, ...(offerWrite ? [SCOPE_WRITE] : []), ...(offline ? [SCOPE_OFFLINE] : [])],
        expiresAt: secondsFromNow(CONSENT_TTL_SECONDS)
    });

    const redirectUrl = new URL(params.redirectUri);

    sendPage(res, 200, consentPage({
        client,
        params: req.body,
        nonce,
        redirectHost: redirectUrl.hostname,
        isLoopback: redirectUrl.protocol === 'http:',
        offerWrite,
        username: toAuthUser(user).username
    }));
};

const handleConsent = async (client, params, req, res) => {
    const nonce = req.body.nonce;

    // Single use: the nonce is consumed before anything else, whatever the decision
    const consent = typeof nonce === 'string' && await OAuthCode.findOneAndUpdate(
        { hash: hashSecret(nonce), kind: 'consent', usedAt: null, expiresAt: { $gt: new Date() } },
        { usedAt: new Date() }
    );

    if (!consent || !sameBinding(consent, requestBinding(client, params))) {
        return sendPage(res, 400, errorPage('This sign-in has expired or is not valid.'));
    }

    if (req.body.decision !== 'allow') {
        throw new AccessDeniedError('The user did not allow access');
    }

    const scopes = [SCOPE_READ];

    if (consent.scopes.includes(SCOPE_WRITE) && req.body.allow_write === 'on') {
        scopes.push(SCOPE_WRITE);
    }

    // One active grant per user and client: connecting again replaces what was allowed before
    const previous = await OAuthGrant.find({ user: consent.user, clientId: client.client_id, revokedAt: null });

    for (const grant of previous) {
        await revokeGrant(grant._id);
    }

    const grant = await OAuthGrant.create({
        user: consent.user,
        clientId: client.client_id,
        clientName: sanitizeClientName(client.client_name),
        scopes
    });

    const code = newSecret();

    await OAuthCode.create({
        kind: 'code',
        hash: hashSecret(code),
        user: consent.user,
        ...requestBinding(client, params),
        scopes: consent.scopes.includes(SCOPE_OFFLINE) ? [...scopes, SCOPE_OFFLINE] : scopes,
        grant: grant._id,
        expiresAt: secondsFromNow(AUTHORIZATION_CODE_TTL_SECONDS)
    });

    const redirect = new URL(params.redirectUri);

    redirect.searchParams.set('code', code);

    if (params.state !== undefined) {
        redirect.searchParams.set('state', params.state);
    }

    res.redirect(302, redirect.href);
};

// ---------- Tokens ----------

const issueTokens = async (grant, scopes) => {
    const accessToken = newSecret();
    const base = {
        grant: grant._id,
        user: grant.user,
        clientId: grant.clientId,
        scopes,
        resource: MCP_RESOURCE
    };

    await OAuthToken.create({
        ...base,
        kind: 'access',
        hash: hashSecret(accessToken),
        expiresAt: secondsFromNow(ACCESS_TOKEN_TTL_SECONDS)
    });

    const tokens = {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: scopes.join(' ')
    };

    if (scopes.includes(SCOPE_OFFLINE)) {
        const refreshToken = newSecret();

        await OAuthToken.create({
            ...base,
            kind: 'refresh',
            hash: hashSecret(refreshToken),
            expiresAt: secondsFromNow(REFRESH_TOKEN_TTL_SECONDS)
        });

        tokens.refresh_token = refreshToken;
    }

    return tokens;
};

const findCode = (client, code) => typeof code === 'string'
    ? OAuthCode.findOne({ hash: hashSecret(code), kind: 'code', clientId: client.client_id })
    : null;

const provider = {
    clientsStore,

    async authorize(client, params, res) {
        const req = res.req;

        if (!isAllowedRedirectUri(params.redirectUri)) {
            throw new CustomOAuthError('invalid_request', 'Redirect URI is not allowed');
        }

        if (!isOurResource(params.resource?.href)) {
            throw new InvalidTargetError('Unknown resource');
        }

        const step = req.method === 'POST' ? req.body.step : undefined;

        if (step === 'signin') {
            return handleSignIn(client, params, req, res);
        }

        if (step === 'consent') {
            return handleConsent(client, params, req, res);
        }

        showSignIn(res, client, req);
    },

    // Called by the SDK before the exchange, to verify PKCE. Presenting a used code revokes what it granted
    async challengeForAuthorizationCode(client, code) {
        const stored = await findCode(client, code);

        if (!stored) {
            throw new InvalidGrantError('Invalid authorization code');
        }

        if (stored.usedAt) {
            await revokeGrant(stored.grant);

            throw new InvalidGrantError('Authorization code has already been used');
        }

        if (stored.expiresAt <= new Date()) {
            throw new InvalidGrantError('Authorization code has expired');
        }

        return stored.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, codeVerifier, redirectUri, resource) {
        const stored = typeof code === 'string' && await OAuthCode.findOneAndUpdate(
            {
                hash: hashSecret(code),
                kind: 'code',
                clientId: client.client_id,
                usedAt: null,
                expiresAt: { $gt: new Date() }
            },
            { usedAt: new Date() }
        );

        if (!stored) {
            throw new InvalidGrantError('Invalid authorization code');
        }

        if (redirectUri !== undefined && redirectUri !== stored.redirectUri) {
            throw new InvalidGrantError('redirect_uri does not match the authorization request');
        }

        if (resource !== undefined && !isOurResource(resource.href)) {
            throw new InvalidTargetError('Unknown resource');
        }

        const grant = await OAuthGrant.findById(stored.grant);

        if (!isActiveGrant(grant)) {
            throw new InvalidGrantError('The access was revoked');
        }

        return issueTokens(grant, stored.scopes);
    },

    // Rotation: every refresh token works once; presenting one again revokes the whole grant
    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
        const stored = await OAuthToken.findOne({ hash: hashSecret(refreshToken), kind: 'refresh' });

        if (!stored || stored.clientId !== client.client_id) {
            throw new InvalidGrantError('Invalid refresh token');
        }

        if (stored.usedAt) {
            await revokeGrant(stored.grant);

            throw new InvalidGrantError('Refresh token has already been used');
        }

        if (stored.revokedAt || stored.expiresAt <= new Date()) {
            throw new InvalidGrantError('Refresh token is expired or revoked');
        }

        if (resource !== undefined && !isOurResource(resource.href)) {
            throw new InvalidTargetError('Unknown resource');
        }

        let granted = stored.scopes;

        if (scopes !== undefined) {
            if (!scopes.every(scope => stored.scopes.includes(scope))) {
                throw new InvalidScopeError('Cannot widen the scopes of a grant');
            }

            // Narrowing keeps offline_access, so the client can go on refreshing
            granted = stored.scopes.filter(scope => scope === SCOPE_OFFLINE || scopes.includes(scope));
        }

        const grant = await OAuthGrant.findById(stored.grant);

        if (!isActiveGrant(grant)) {
            throw new InvalidGrantError('The access was revoked');
        }

        const consumed = await OAuthToken.updateOne({ _id: stored._id, usedAt: null }, { usedAt: new Date() });

        if (consumed.modifiedCount === 0) {
            throw new InvalidGrantError('Refresh token has already been used');
        }

        return issueTokens(grant, granted);
    },

    async verifyAccessToken(token) {
        const stored = typeof token === 'string'
            ? await OAuthToken.findOne({ hash: hashSecret(token), kind: 'access', revokedAt: null })
            : null;

        if (!stored) {
            throw new InvalidTokenError('Invalid access token');
        }

        if (stored.expiresAt <= new Date()) {
            throw new InvalidTokenError('Access token has expired');
        }

        const grant = await OAuthGrant.findById(stored.grant);

        if (!isActiveGrant(grant)) {
            throw new InvalidTokenError('The access was revoked');
        }

        const now = Date.now();

        if (!grant.lastUsedAt || now - grant.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
            await OAuthGrant.updateOne({ _id: grant._id }, { lastUsedAt: new Date(now) });
        }

        return {
            token,
            clientId: stored.clientId,
            scopes: stored.scopes,
            expiresAt: Math.floor(stored.expiresAt.getTime() / 1000),
            resource: new URL(stored.resource),
            extra: { userId: String(stored.user), grantId: String(grant._id) }
        };
    },

    // RFC 7009: an unknown token is not an error. A refresh token takes its whole grant with it
    async revokeToken(client, { token }) {
        const stored = await OAuthToken.findOne({ hash: hashSecret(token), clientId: client.client_id });

        if (!stored) {
            return;
        }

        if (stored.kind === 'refresh') {
            await revokeGrant(stored.grant);
        } else {
            await OAuthToken.updateOne({ _id: stored._id, revokedAt: null }, { revokedAt: new Date() });
        }
    }
};

// ---------- Grants, for the web app ----------

const listGrants = async (userId) => {
    const grants = await OAuthGrant.find({ user: userId, revokedAt: null }).sort({ createdAt: -1, _id: -1 });

    return grants.map(grant => ({
        id: String(grant._id),
        clientName: grant.clientName,
        scopes: grant.scopes,
        canWrite: grant.scopes.includes(SCOPE_WRITE),
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt
    }));
};

// Revoke one of the user's active grants; false when there is none with this id
const revokeUserGrant = async (userId, id) => {
    const grantId = parseObjectId(id);
    const grant = grantId && await OAuthGrant.findOne({ _id: grantId, user: userId, revokedAt: null });

    if (!grant) {
        return false;
    }

    await revokeGrant(grant._id);

    return true;
};

module.exports = {
    provider,
    listGrants,
    revokeUserGrant,
    hashSecret
};
