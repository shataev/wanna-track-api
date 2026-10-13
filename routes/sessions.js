const router = require('express').Router();
const { authenticate } = require('../middlewares/authenticate');
const { listSessions, revokeSession, revokeOtherSessions } = require('../services/sessionService');
const { clearRefreshCookies } = require('../utils/refreshCookie');

// The devices the caller is signed in on, for Profile → Devices
router.get('/sessions', authenticate, async (req, res) => {
    try {
        res.status(200).json(await listSessions(req.user.id, req.sessionId));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to list the sessions' });
    }
});

// Sign a device out; the current one is signing out here
router.delete('/sessions/:id', authenticate, async (req, res) => {
    try {
        if (!(await revokeSession(req.user.id, req.params.id))) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (req.params.id === req.sessionId) {
            clearRefreshCookies(res);
        }

        res.status(204).end();
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to revoke the session' });
    }
});

router.post('/sessions/revoke-others', authenticate, async (req, res) => {
    // An access token from before sessions names none: which one to keep is unknown until it is refreshed
    if (!req.sessionId) {
        return res.status(409).json({ error: 'The current session is unknown: refresh the access token first' });
    }

    try {
        res.status(200).json({ revoked: await revokeOtherSessions(req.user.id, req.sessionId) });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to revoke the other sessions' });
    }
});

module.exports = router;
