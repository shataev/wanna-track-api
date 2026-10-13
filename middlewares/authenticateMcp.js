const { provider } = require('../services/oauthProvider');
const { getUserFromDatabaseById } = require('../utils/auth.utils');
const { RESOURCE_METADATA_URL, SCOPES_SUPPORTED, SCOPE_READ } = require('../utils/oauth.config');

// What a client needs to start the OAuth flow; Claude reads it only from a 401
const WWW_AUTHENTICATE = `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="${SCOPES_SUPPORTED.join(' ')}"`;

const unauthorized = (res, description) => res
    .status(401)
    .set('WWW-Authenticate', WWW_AUTHENTICATE)
    .json({ error: 'invalid_token', error_description: description });

/**
 * /mcp accepts only an OAuth access token issued by /oauth/token: never the web app's JWT, never the bot secret.
 * Sets req.user (the shape of toAuthUser) and req.auth (the SDK's AuthInfo, with the granted scopes).
 */
const authenticateMcp = async (req, res, next) => {
    try {
        if (req.headers['x-telegram-bot-secret'] !== undefined) {
            return unauthorized(res, 'Bot credentials are not accepted here');
        }

        const [type, token] = (req.headers.authorization ?? '').split(' ');

        if (!type || type.toLowerCase() !== 'bearer' || !token) {
            return unauthorized(res, 'Missing access token');
        }

        let authInfo;

        try {
            authInfo = await provider.verifyAccessToken(token);
        } catch (error) {
            return unauthorized(res, error.message);
        }

        if (!authInfo.scopes.includes(SCOPE_READ)) {
            return res.status(403).json({ error: 'insufficient_scope', error_description: 'The token cannot read expenses' });
        }

        const user = await getUserFromDatabaseById(authInfo.extra.userId);

        if (!user) {
            return unauthorized(res, 'Unknown user');
        }

        req.user = user;
        req.auth = authInfo;

        next();
    } catch (error) {
        console.error('[authenticateMcp] error', error);
        res.status(500).json({ error: 'server_error' });
    }
};

module.exports = { authenticateMcp };
