const { createSession, refreshSession } = require('../services/sessionService');
const { setRefreshCookie, COOKIE_NAME } = require('../utils/refreshCookie');

const deviceOf = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

module.exports = {
    // After sign-in or sign-up: a new session for req.user, its secret in the cookie
    async startSession(req, res, next) {
        try {
            const { session, secret } = await createSession(req.user.id, deviceOf(req));

            req.sessionId = session._id.toString();
            setRefreshCookie(res, secret, session.expiresAt);

            next();
        } catch (error) {
            console.error('[startSession] error', error);
            res.status(500).json({ message: 'Failed to start a session' });
        }
    },
    // Sets req.user and req.sessionId from the refresh cookie, rotating it; 401 when it opens nothing
    async refreshFromCookie(req, res, next) {
        try {
            const result = await refreshSession(req.cookies?.[COOKIE_NAME], deviceOf(req));

            if (!result) {
                return res.status(401).json({ message: 'Unauthorized: missing, invalid or expired refresh token' });
            }

            // No new secret within the rotation grace: the concurrent refresh that won has set the cookie
            if (result.secret) {
                setRefreshCookie(res, result.secret, result.session.expiresAt);
            }

            req.user = result.user;
            req.sessionId = result.session._id.toString();

            next();
        } catch (error) {
            console.error('[refreshFromCookie] error', error);
            res.status(500).json({ message: 'Failed to refresh the session' });
        }
    }
};
