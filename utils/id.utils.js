const mongoose = require('mongoose');
const ObjectId = mongoose.Types.ObjectId;

/**
 * An ObjectId from a request value, or null when the value is not a 24-character hex id.
 * Lets a route answer 404 for a malformed id instead of letting Mongoose throw a CastError (500).
 */
const parseObjectId = (value) => {
    if (value instanceof ObjectId) {
        return value;
    }

    if (typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value)) {
        return null;
    }

    return new ObjectId(value);
};

module.exports = { parseObjectId };
