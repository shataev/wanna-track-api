const jwt = require("jsonwebtoken");
const {generateAccessToken} = require("../utils/auth.utils");

module.exports = {
    setAccessTokenToReq(req, res, next) {
        const {username, email, id} = req.user;

        // The token carries only what identifies the user; the rest is read from the database per request
        req.accessToken = generateAccessToken({username, email, id})

        next();
    }
}
