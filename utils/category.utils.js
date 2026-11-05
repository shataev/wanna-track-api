const Category = require('../models/Category');

/**
 * Whether the user may use the category: a global one (user: null) or one of their own.
 * `categoryId` is an ObjectId (see parseObjectId), or null for a malformed id.
 */
const isCategoryUsable = async (userId, categoryId) => Boolean(
    categoryId && await Category.exists({ _id: categoryId, user: { $in: [null, userId] } })
);

module.exports = { isCategoryUsable };
