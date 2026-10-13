// The web's refresh cookie: sent only to /api/auth, never to the data routes, and unreadable by scripts.
// Local development serves the web from another site (localhost), which needs sameSite 'none'
const COOKIE_NAME = 'refreshToken';
const COOKIE_PATH = '/api/auth';

// Before sessions the cookie lived at '/': cleared alongside every set, so the browser stops sending a stale one
const LEGACY_COOKIE_PATH = '/';

const cookieOptions = () => ({
    httpOnly: true,
    secure: true,
    sameSite: process.env.stage === 'development' ? 'none' : 'lax'
});

const clearLegacyRefreshCookie = (res) => {
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), path: LEGACY_COOKIE_PATH });
};

module.exports = {
    COOKIE_NAME,
    COOKIE_PATH,
    // Lives as long as the session can slide without another refresh
    setRefreshCookie(res, secret, expiresAt) {
        clearLegacyRefreshCookie(res);
        res.cookie(COOKIE_NAME, secret, {
            ...cookieOptions(),
            path: COOKIE_PATH,
            maxAge: Math.max(0, expiresAt.getTime() - Date.now())
        });
    },
    clearRefreshCookies(res) {
        clearLegacyRefreshCookie(res);
        res.clearCookie(COOKIE_NAME, { ...cookieOptions(), path: COOKIE_PATH });
    }
};
