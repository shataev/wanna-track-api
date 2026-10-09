const jwt = require("jsonwebtoken");
const User = require("../models/User");

const ACCESS_TOKEN_EXPIRATION_TIME_SECONDS = 15 * 60
const REFRESH_TOKEN_EXPIRATION_TIME_SECONDS = 2 * 60 * 60

// The user as the API hands it out: to route handlers in req.user and to the client from signin/signup/refresh
const toAuthUser = (user) => {
    const {username, email, _id: id, defaultCurrency, telegramId, verified, activeTag} = user;

    return {
        email,
        username,
        id,
        defaultCurrency,
        // null rather than undefined, so the key survives JSON for clients that check it
        telegramId: telegramId ?? null,
        verified,
        activeTag: activeTag ?? null
    }
}

module.exports = {
    toAuthUser,
    ACCESS_TOKEN_EXPIRATION_TIME_SECONDS,
    REFRESH_TOKEN_EXPIRATION_TIME_SECONDS,
    generateAccessToken(user) {
        return jwt.sign(
            { ...user },
            process.env.SECRET_KEY,
            {
                // ACCESS_TOKEN_TTL_SECONDS shortens the lifetime for tests and local expiry checks
                expiresIn: Number(process.env.ACCESS_TOKEN_TTL_SECONDS) || ACCESS_TOKEN_EXPIRATION_TIME_SECONDS
            }
        )
    },
    generateRefreshToken(userId) {
        return jwt.sign(
            {userId},
            process.env.SECRET_KEY_REFRESH,
            {
                expiresIn: REFRESH_TOKEN_EXPIRATION_TIME_SECONDS
            }
        )
    },
    // The user named by a refresh token, or null when the token is missing, invalid or expired
    async getUserFromRefreshToken(refreshToken) {
        if (!refreshToken) {
            return null;
        }

        try {
            const {userId} = jwt.verify(refreshToken, process.env.SECRET_KEY_REFRESH);

            return await module.exports.getUserFromDatabaseById(userId);
        } catch (error) {
            return null;
        }
    },
    // TODO: db error handling
    async getUserFromDatabaseById(userId) {
        const user = await User.findById(userId);

        if (!user) {
            return null
        }

        return toAuthUser(user);
    }
}
