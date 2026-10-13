const express = require('express');
const { authorizationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/authorize.js');
const { tokenHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/token.js');
const { clientRegistrationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/register.js');
const { revocationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/revoke.js');
const { metadataHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/metadata.js');
const { provider } = require('../services/oauthProvider');
const { ISSUER, MCP_RESOURCE, SCOPES_SUPPORTED } = require('../utils/oauth.config');

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

router.use('/oauth/register', clientRegistrationHandler({ clientsStore: provider.clientsStore }));
router.use('/oauth/authorize', authorizationHandler({ provider }));

// An unknown or deleted client is 401 invalid_client, so Claude registers again; the SDK would answer 400
router.post('/oauth/token', async (req, res, next) => {
    try {
        const clientId = req.body?.client_id;

        if (typeof clientId === 'string' && !(await provider.clientsStore.getClient(clientId))) {
            return res
                .status(401)
                .set('Cache-Control', 'no-store')
                .json({ error: 'invalid_client', error_description: 'Unknown client' });
        }

        next();
    } catch (error) {
        next(error);
    }
});
router.use('/oauth/token', tokenHandler({ provider }));
router.use('/oauth/revoke', revocationHandler({ provider }));

module.exports = router;
