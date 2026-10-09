const { isSecretValid } = require('./checkTelegramBotSecret');

/**
 * Guards maintenance routes with the X-Admin-Secret header.
 * Without ADMIN_SECRET configured the route does not exist (404), so it is closed by default.
 */
const requireAdminSecret = (req, res, next) => {
    const secret = process.env.ADMIN_SECRET;

    if (!secret) {
        return res.status(404).json({ message: 'Not found' });
    }

    if (!isSecretValid(req.headers['x-admin-secret'], secret)) {
        return res.status(403).json({ message: 'Forbidden: invalid admin secret' });
    }

    next();
};

module.exports = { requireAdminSecret };
