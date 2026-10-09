const {getVerificationByUserId, checkVerificationExpiration, removeVerificationById, VERIFICATION_EMAIL_STATUS,
    VERIFICATION_EMAIL_STATUS_NOT_FOUND, VERIFICATION_EMAIL_STATUS_INVALID, VERIFICATION_EMAIL_STATUS_SUCCESS,
    VERIFICATION_EMAIL_STATUS_ERROR, VERIFICATION_EMAIL_STATUS_EXPIRED, VERIFICATION_EMAIL_STATUS_USER_NOT_FOUND,
    VERIFICATION_EMAIL_STATUS_ALREADY_VERIFIED
} = require("../utils/verify.utils");
const router = require('express').Router();
const User = require('../models/User');
const CryptoJS = require("crypto-js");
const {checkUserInDatabaseById} = require("../middlewares/checkUserInDatabaseById");
const {checkIsUserVerified} = require("../middlewares/checkIsUserVerified");
const {deleteVerificationFromDatabase} = require("../middlewares/deleteVerificationFromDatabase");
const {sendVerificationEmail} = require("../middlewares/sendVerificationEmail");

/**
 * Route for verification email address
 */
router.get('/:userId/:verificationString', async(req, res) => {
    const {userId, verificationString} = req.params;
    let verificationStatus;

    try {
        const verification = await getVerificationByUserId(userId);
        const user = await User.findById(userId);

        // User not found in database
        if (!user) {
            verificationStatus = VERIFICATION_EMAIL_STATUS_USER_NOT_FOUND;
        } else {
            // Verification link was not found in database
            if (!verification) {
                // Because email had already verified
                if (!!user.verified) {
                    verificationStatus = VERIFICATION_EMAIL_STATUS_ALREADY_VERIFIED;
                } else {
                    // Or user don't have generated verification link
                    verificationStatus = VERIFICATION_EMAIL_STATUS_NOT_FOUND;
                }

            } else {
                // Check link for expiration
                const isVerificationExpired = checkVerificationExpiration(verification.expiresAt);

                if (isVerificationExpired) {
                    await removeVerificationById(verification._id)

                    verificationStatus = VERIFICATION_EMAIL_STATUS_EXPIRED;
                } else {
                    // Check verification string
                    const bytes  = CryptoJS.AES.decrypt(verification.uniqueString, process.env.SECRET_KEY);
                    const verificationStringFormDB = bytes.toString(CryptoJS.enc.Utf8);

                    if (verificationStringFormDB !== verificationString) {
                        verificationStatus = VERIFICATION_EMAIL_STATUS_INVALID;
                    } else {
                        await removeVerificationById(verification._id)
                        await User.updateOne({_id: userId}, {verified: true})

                        verificationStatus = VERIFICATION_EMAIL_STATUS_SUCCESS;
                    }
                }
            }
        }
    } catch(e) {
        console.log(e)
        verificationStatus = VERIFICATION_EMAIL_STATUS_ERROR;
    }

    res.redirect(301, `${process.env.CLIENT_URL}/email-verification?status=${verificationStatus}&userId=${userId}`)

})

/**
 * Route for generation a new email verification link.
 * - check userId from the request body
 * - generate new link
 * - remove previous item from Verification table
 * - create a new item in Verification table
 */
router.post('/email', [
    checkUserInDatabaseById,
    checkIsUserVerified,
    deleteVerificationFromDatabase,
    sendVerificationEmail,
    (req, res) => {

    if (req.verificationEmailSendingStatus === 'success') {
        res
            .status(200)
            .json('Email verification sent. Check your email');
    } else {
        res
            .status(500)
            .json('Something went wrong during generation or sending new verification email');
    }

}])

module.exports = router;