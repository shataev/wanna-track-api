const jwt = require("jsonwebtoken");
const {generateAccessToken} = require("../utils/auth.utils");

module.exports = {
    setAccessTokenToReq(req, res, next) {
        const {username, email, id} = req.user;

        // The token carries only what identifies the user, and the session it was issued for (sid), which
        // the session list marks as the current one; the rest is read from the database per request
        req.accessToken = generateAccessToken({username, email, id, sid: req.sessionId})

        next();
    }
}
