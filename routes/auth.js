const router = require('express').Router();
const { setRefreshTokenCookie } = require('../middlewares/setRefreshTokenCookie');
const { createUser } = require("../middlewares/createUser");
const { setAccessTokenToReq } = require("../middlewares/setAccessTokenToReq");
const { checkUserInDatabase } = require("../middlewares/checkUserInDatabase");
const { checkAccessToken } = require("../middlewares/checkAuth");
const { sendVerificationEmail } = require("../middlewares/sendVerificationEmail");
const { getUserFromRefreshToken } = require("../utils/auth.utils");

// Silent Authentication
// Kept for web bundles deployed before POST /refresh existed
router.get('/', [
    checkAccessToken,
    setRefreshTokenCookie,
    (req, res) => {
        res
            .status(201)
            .json({
                ...req.user,
                accessToken: req.accessToken});
}])

// Refresh: the only route that authenticates by the refresh cookie on purpose
router.post('/refresh', [
    async (req, res, next) => {
        const user = await getUserFromRefreshToken(req.cookies?.refreshToken);

        if (!user) {
            return res.status(401).json({ message: 'Unauthorized: missing, invalid or expired refresh token' });
        }

        req.user = user;

        next();
    },
    setRefreshTokenCookie,
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
    setRefreshTokenCookie,
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
    setRefreshTokenCookie,
    setAccessTokenToReq,
    (req, res) => {
        res.status(200)
            .json({
                ...req.user,
                user: req.user,
                accessToken: req.accessToken});
    }
])

// SignOut
router.post('/signout', async (req, res) => {
    // Clear cookie
    res.cookie('refreshToken', null, {
        httpOnly: true,
        expires: new Date(Date.now()),
    });

    res
      .status(200)
      .send('Successfully logged out');
})

module.exports = router;
