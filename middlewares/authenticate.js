const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { getUserFromDatabaseById, getUserFromRefreshToken, toAuthUser } = require('../utils/auth.utils');
const { isSecretValid } = require('./checkTelegramBotSecret');

/**
 * Sets req.user (the shape of toAuthUser) and req.auth ('user' or 'bot') from exactly one credential:
 * - Authorization: Bearer <access token>; an invalid or expired token is a 401, never a fallback to the cookie
 * - X-Telegram-Bot-Secret + X-Telegram-User-Id; the user is the one linked to that Telegram id
 *
 * While AUTH_ENFORCE is not 'true', two legacy paths keep the clients deployed before this change working:
 * - legacy web: the refreshToken cookie names the user (the old web sends no bearer on data calls)
 * - legacy bot: the bot secret + a userId in the query or body (the old bot sends no Telegram id)
 * A userId on its own is never trusted.
 *
 * The bot may only reach routes that opt in with authenticateUserOrBot.
 */

const isEnforced = () => process.env.AUTH_ENFORCE === 'true';

const unauthorized = (res, message) => res.status(401).json({ message: `Unauthorized: ${message}` });

const logLegacy = (kind, req) => console.warn('[auth-legacy]', kind, req.method, req.originalUrl.split('?')[0]);

const findUserById = async (id) => {
    if (typeof id !== 'string' || !mongoose.isObjectIdOrHexString(id)) {
        return null;
    }

    return getUserFromDatabaseById(id);
};

const fromBearer = async (authHeader) => {
    try {
        const { id } = jwt.verify(authHeader.slice('Bearer '.length).trim(), process.env.SECRET_KEY);

        return await findUserById(id);
    } catch (error) {
        return null;
    }
};

const resolve = async (req, res) => {
    const authHeader = req.headers.authorization;
    const hasBearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ');
    const hasBotSecret = req.headers['x-telegram-bot-secret'] !== undefined;

    if (hasBearer && hasBotSecret) {
        res.status(400).json({ message: 'Send either a bearer token or bot credentials, not both' });
        return null;
    }

    if (hasBearer) {
        const user = await fromBearer(authHeader);

        if (!user) {
            unauthorized(res, 'invalid or expired access token');
            return null;
        }

        return { user, auth: 'user' };
    }

    if (hasBotSecret) {
        const secret = process.env.TELEGRAM_BOT_SECRET;

        if (!secret) {
            console.error('[authenticate] TELEGRAM_BOT_SECRET is not set, rejecting the bot request');
            res.status(500).json({ message: 'Telegram bot integration is not configured' });
            return null;
        }

        if (!isSecretValid(req.headers['x-telegram-bot-secret'], secret)) {
            res.status(403).json({ message: 'Forbidden: invalid bot secret' });
            return null;
        }

        const telegramId = req.headers['x-telegram-user-id'];

        if (telegramId !== undefined) {
            const user = await User.findOne({ telegramId: String(telegramId) });

            if (!user) {
                unauthorized(res, 'this Telegram account is not linked');
                return null;
            }

            return { user: toAuthUser(user), auth: 'bot' };
        }

        if (isEnforced()) {
            unauthorized(res, 'X-Telegram-User-Id is required');
            return null;
        }

        // Express 5 leaves req.body undefined on a request without a body
        const user = await findUserById(req.query.userId ?? req.body?.userId);

        if (!user) {
            unauthorized(res, 'unknown user');
            return null;
        }

        logLegacy('bot', req);

        return { user, auth: 'bot' };
    }

    const refreshToken = req.cookies?.refreshToken;

    if (!isEnforced() && refreshToken) {
        const user = await getUserFromRefreshToken(refreshToken);

        if (user) {
            logLegacy('web', req);

            return { user, auth: 'user' };
        }
    }

    unauthorized(res, 'no valid credentials');
    return null;
};

const createAuthenticate = ({ allowBot }) => async (req, res, next) => {
    try {
        const identity = await resolve(req, res);

        if (!identity) {
            return;
        }

        if (identity.auth === 'bot' && !allowBot) {
            return res.status(403).json({ message: 'Forbidden: this route is not available to the bot' });
        }

        req.user = identity.user;
        req.auth = identity.auth;

        next();
    } catch (error) {
        console.error('[authenticate] error', error);
        res.status(500).json({ message: 'Authentication failed' });
    }
};

module.exports = {
    authenticate: createAuthenticate({ allowBot: false }),
    authenticateUserOrBot: createAuthenticate({ allowBot: true })
};
