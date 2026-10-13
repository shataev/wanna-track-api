const express = require('express');
const { authorizationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/authorize.js');
const { tokenHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/token.js');
const { clientRegistrationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/register.js');
const { revocationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/revoke.js');
const { metadataHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/metadata.js');
const { provider, countPendingClients } = require('../services/oauthProvider');
const {
    ISSUER,
    MCP_RESOURCE,
    SCOPES_SUPPORTED,
    MAX_PENDING_CLIENTS,
    MAX_REGISTRATION_BODY,
    isAnthropicIp
} = require('../utils/oauth.config');

/**
 * The OAuth 2.1 authorization server for the MCP endpoint, built from the MCP SDK's handlers:
 * - discovery: protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414)
 * - /oauth/register: dynamic client registration (RFC 7591), public clients with Claude's redirect URIs only
 * - /oauth/authorize: sign in and consent pages, PKCE S256 only
 * - /oauth/token: authorization code and refresh token grants, form-encoded
 * - /oauth/revoke: token revocation (RFC 7009)
 * The SDK's own mcpAuthRouter is not used: it fixes the endpoint paths, advertises client secrets and
 * serves the resource metadata at one path only.
 */

const router = express.Router();

const protectedResourceMetadata = {
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Wanna Track'
};

// No client_id_metadata_document_supported: Claude then registers through DCR on every surface
const authorizationServerMetadata = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    revocation_endpoint: `${ISSUER}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES_SUPPORTED
};

router.use('/.well-known/oauth-protected-resource/mcp', metadataHandler(protectedResourceMetadata));
router.use('/.well-known/oauth-protected-resource', metadataHandler(protectedResourceMetadata));
router.use('/.well-known/oauth-authorization-server', metadataHandler(authorizationServerMetadata));

// Form bodies only here: the rest of the API takes JSON
router.use('/oauth', express.urlencoded({ extended: false }));

const oauthError = (res, status, error, description) => res
    .status(status)
    .set('Cache-Control', 'no-store')
    .json({ error, error_description: description });

// Registration: a small body only, and at most MAX_PENDING_CLIENTS registrations nobody has allowed yet.
// The cap is global because claude.ai registers from Anthropic's shared egress range: a per-IP limit there
// would let any claude.ai user exhaust it for the owner. Other addresses also get a per-IP limit
const registrationBody = express.json({ limit: MAX_REGISTRATION_BODY });

router.post('/oauth/register', (req, res, next) => registrationBody(req, res, (error) => {
    if (error) {
        return error.type === 'entity.too.large'
            ? oauthError(res, 413, 'invalid_client_metadata', `The registration must not be larger than ${MAX_REGISTRATION_BODY}`)
            : oauthError(res, 400, 'invalid_client_metadata', 'The registration must be JSON');
    }

    next();
}), async (req, res, next) => {
    try {
        if (await countPendingClients() >= MAX_PENDING_CLIENTS) {
            return oauthError(res, 429, 'too_many_requests', 'Too many registrations in progress, try again later');
        }

        next();
    } catch (error) {
        next(error);
    }
});
router.use('/oauth/register', clientRegistrationHandler({
    clientsStore: provider.clientsStore,
    rateLimit: { windowMs: 60 * 60 * 1000, max: 100, skip: (req) => isAnthropicIp(req.ip) }
}));

// Error redirects of the SDK's authorize handler: a failed validation sends raw zod JSON as the description
// and leaves out `state`, which RFC 6749 4.1.2.1 requires when the request had one. Both are put right here
router.use('/oauth/authorize', (req, res, next) => {
    const redirect = res.redirect.bind(res);
    const state = (req.method === 'POST' ? req.body : req.query)?.state;

    res.redirect = (status, location) => {
        try {
            const url = new URL(location);

            if (url.searchParams.has('error')) {
                const description = url.searchParams.get('error_description');

                if (description && /^\s*[[{]/.test(description)) {
                    url.searchParams.set('error_description', shortDescription(description));
                }

                if (!url.searchParams.has('state') && typeof state === 'string') {
                    url.searchParams.set('state', state);
                }

                return redirect(status, url.href);
            }
        } catch (error) {
            // Not a URL the SDK built: leave it as it is
        }

        return redirect(status, location);
    };

    next();
});
router.use('/oauth/authorize', authorizationHandler({ provider }));

// "Invalid or missing: code_challenge_method" from the SDK's zod issues
function shortDescription(raw) {
    try {
        const issues = JSON.parse(raw);
        const fields = [...new Set((Array.isArray(issues) ? issues : []).map(issue => (issue.path ?? []).join('.')).filter(Boolean))];

        return fields.length > 0 ? `Invalid or missing: ${fields.join(', ')}` : 'Invalid authorization request';
    } catch (error) {
        return 'Invalid authorization request';
    }
}

// An unknown or deleted client is 401 invalid_client, so Claude registers again; the SDK would answer 400
const requireKnownClient = async (req, res, next) => {
    try {
        const clientId = req.body?.client_id;

        if (typeof clientId === 'string' && !(await provider.clientsStore.getClient(clientId))) {
            return oauthError(res, 401, 'invalid_client', 'Unknown client');
        }

        next();
    } catch (error) {
        next(error);
    }
};

router.post('/oauth/token', requireKnownClient);
router.use('/oauth/token', tokenHandler({ provider }));
router.post('/oauth/revoke', requireKnownClient);
router.use('/oauth/revoke', revocationHandler({ provider }));

module.exports = router;
