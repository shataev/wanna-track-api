const router = require('express').Router();
const { authenticate } = require('../middlewares/authenticate');
const { listGrants, revokeUserGrant } = require('../services/oauthProvider');

// The apps the caller connected through OAuth (Claude), for Profile → Connected apps
router.get('/oauth/grants', authenticate, async (req, res) => {
    try {
        res.status(200).json(await listGrants(req.user.id));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to list the connected apps' });
    }
});

// Disconnect an app: the grant and every token issued under it stop working at once
router.delete('/oauth/grants/:id', authenticate, async (req, res) => {
    try {
        if (!(await revokeUserGrant(req.user.id, req.params.id))) {
            return res.status(404).json({ error: 'Connected app not found' });
        }

        res.status(204).end();
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to disconnect the app' });
    }
});

module.exports = router;
