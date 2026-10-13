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

// Claude's hosted apps register and call from Anthropic's egress range, shared by every claude.ai user,
// so a per-IP limit there would let anyone's connector use up the owner's budget
const isAnthropicIp = (ip) => {
    const match = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? ''));

    // 160.79.104.0/21: 160.79.104.0 to 160.79.111.255
    return Boolean(match) && match[1] === '160' && match[2] === '79' && Number(match[3]) >= 104 && Number(match[3]) <= 111;
};

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const CONSENT_TTL_SECONDS = 10 * 60;
// A registered client nobody allowed within a day is deleted
const PENDING_CLIENT_TTL_SECONDS = 24 * 60 * 60;
// At most this many such clients at a time, whoever registers them
const MAX_PENDING_CLIENTS = 200;
// A grant nobody used for this long stops working and leaves the list
const GRANT_IDLE_TTL_SECONDS = 60 * 24 * 60 * 60;
const MAX_REGISTRATION_BODY = '16kb';

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
    isAnthropicIp,
    ACCESS_TOKEN_TTL_SECONDS,
    REFRESH_TOKEN_TTL_SECONDS,
    AUTHORIZATION_CODE_TTL_SECONDS,
    CONSENT_TTL_SECONDS,
    PENDING_CLIENT_TTL_SECONDS,
    MAX_PENDING_CLIENTS,
    GRANT_IDLE_TTL_SECONDS,
    MAX_REGISTRATION_BODY
};
