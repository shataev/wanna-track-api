const User = require('../models/User');
const { toAuthUser } = require('../utils/auth.utils');
const { normalizeTag } = require('../utils/tag.utils');

// Set the tag every new cost gets unless it says otherwise; null, or a tag that normalises to nothing, clears it.
// The updated user in the shape of toAuthUser, or null when there is no such user
const setActiveTag = async (userId, tag) => {
    const user = await User.findByIdAndUpdate(userId, { activeTag: normalizeTag(tag) }, { new: true });

    return user ? toAuthUser(user) : null;
};

module.exports = { setActiveTag };
