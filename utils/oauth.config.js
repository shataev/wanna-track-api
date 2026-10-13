// The public address of the API: the OAuth issuer and, with /mcp, the protected resource.
// PUBLIC_API_URL overrides it for a local run; production uses the default.
const PUBLIC_URL = (process.env.PUBLIC_API_URL || 'https://api.wannatrack.shataev.com').replace(/\/+$/, '');

const SCOPE_READ = 'expenses.read';
const SCOPE_WRITE = 'expenses.write';
const SCOPE_OFFLINE = 'offline_access';

const ISSUER = PUBLIC_URL;
const MCP_RESOURCE = `${PUBLIC_URL}/mcp`;
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`;
const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE];

// Redirect URIs a client may register: the hosted Claude apps exactly, Claude Code on a loopback port
const HOSTED_REDIRECT_URIS = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback'
];

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

const isAllowedRedirectUri = (value) => {
    if (typeof value !== 'string') {
        return false;
    }

    if (HOSTED_REDIRECT_URIS.includes(value)) {
        return true;
    }

    let url;

    try {
        url = new URL(value);
    } catch (error) {
        return false;
    }

    // Any port: Claude Code listens on an ephemeral one
    return url.protocol === 'http:'
        && LOOPBACK_HOSTS.includes(url.hostname)
        && url.pathname === '/callback'
        && !url.search
        && !url.hash
        && !url.username
        && !url.password
        && value === `http://${url.host}/callback`;
};

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const CONSENT_TTL_SECONDS = 10 * 60;

module.exports = {
    PUBLIC_URL,
    ISSUER,
    MCP_RESOURCE,
    RESOURCE_METADATA_URL,
    SCOPE_READ,
    SCOPE_WRITE,
    SCOPE_OFFLINE,
    SCOPES_SUPPORTED,
    isAllowedRedirectUri,
    ACCESS_TOKEN_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS,
    AUTHORIZATION_CODE_TTL_SECONDS,
    CONSENT_TTL_SECONDS
};
