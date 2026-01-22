const jwt = require("jsonwebtoken");
const User = require("../models/User");

const ACCESS_TOKEN_EXPIRATION_TIME_SECONDS = 15 * 60
const REFRESH_TOKEN_EXPIRATION_TIME_SECONDS = 2 * 60 * 60

module.exports = {
    ACCESS_TOKEN_EXPIRATION_TIME_SECONDS,
    REFRESH_TOKEN_EXPIRATION_TIME_SECONDS,
    generateAccessToken(user) {
        return jwt.sign(
            { ...user },
            process.env.SECRET_KEY,
            {
                expiresIn: ACCESS_TOKEN_EXPIRATION_TIME_SECONDS
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
    // TODO: db error handling
    async getUserFromDatabaseById(userId) {
        const user = await User.findById(userId);

        if (!user) {
            return null
        }

        const {username, email, _id: id, defaultCurrency} = user;

        return {
            email,
            username,
            id,
            defaultCurrency
        }
    }
}
