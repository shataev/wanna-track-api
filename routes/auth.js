const router = require('express').Router();
const { createUser } = require("../middlewares/createUser");
const { setAccessTokenToReq } = require("../middlewares/setAccessTokenToReq");
const { checkUserInDatabase } = require("../middlewares/checkUserInDatabase");
const { sendVerificationEmail } = require("../middlewares/sendVerificationEmail");
const { startSession, refreshFromCookie } = require("../middlewares/session");
const { revokeByCookie } = require("../services/sessionService");
const { clearRefreshCookies, COOKIE_NAME } = require("../utils/refreshCookie");

// Silent Authentication
// Kept for web bundles deployed before POST /refresh existed; the same exchange of the cookie as /refresh
router.get('/', [
    refreshFromCookie,
    setAccessTokenToReq,
    (req, res) => {
        res
            .status(201)
            .json({
                ...req.user,
                accessToken: req.accessToken});
}])

// Refresh: the only route that authenticates by the refresh cookie on purpose
router.post('/refresh', [
    refreshFromCookie,
    setAccessTokenToReq,
    (req, res) => {
        res
            .status(200)
            .json({
                accessToken: req.accessToken,
                user: req.user
            });
    }
])

// SignUp
router.post('/signup', [
    createUser,
    sendVerificationEmail,
    startSession,
    setAccessTokenToReq,
    (req, res) => {
      res
          .status(201)
          .json({
            ...req.user,
            user: req.user,
            verificationEmailSendingStatus: req.verificationEmailSendingStatus,
            // TODO: delete after testing email confirmation endpoint
            verificationEmailLink: req.verificationLink,
            accessToken: req.accessToken});
  }
])

// SignIn
router.post('/signin', [
    checkUserInDatabase,
    startSession,
    setAccessTokenToReq,
    (req, res) => {
        res.status(200)
            .json({
                ...req.user,
                user: req.user,
                accessToken: req.accessToken});
    }
])

// SignOut: ends the session of the cookie; needs no access token, it may have expired
router.post('/signout', async (req, res) => {
    try {
        await revokeByCookie(req.cookies?.[COOKIE_NAME]);
    } catch (error) {
        console.error('[signout] error', error);
        return res.status(500).json({ message: 'Failed to sign out' });
    }

    clearRefreshCookies(res);

    res
      .status(200)
      .send('Successfully logged out');
})

module.exports = router;
