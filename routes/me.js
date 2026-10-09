const router = require('express').Router();
const User = require('../models/User');
const { authenticateUserOrBot } = require('../middlewares/authenticate');
const { toAuthUser } = require('../utils/auth.utils');
const { normalizeTag } = require('../utils/tag.utils');

// The caller, in the shape signin returns
router.get('/me', authenticateUserOrBot, (req, res) => {
    res.status(200).json(req.user);
});

// Set the tag every new cost gets unless it says otherwise; null, or a tag that normalises to nothing, clears it
router.put('/me/active-tag', authenticateUserOrBot, async (req, res) => {
    try {
        const { tag } = req.body ?? {};

        if (tag !== null && typeof tag !== 'string') {
            return res.status(400).json({ error: 'Tag must be a string or null' });
        }

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { activeTag: normalizeTag(tag) },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.status(200).json(toAuthUser(user));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'Failed to set the active tag' });
    }
});

module.exports = router;
