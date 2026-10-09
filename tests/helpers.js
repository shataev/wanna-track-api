const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Fund = require('../models/Fund');
const Category = require('../models/Category');
const { generateAccessToken, generateRefreshToken } = require('../utils/auth.utils');

const TEST_PASSWORD = 'test-password';

let counter = 0;

async function seedUser(overrides = {}) {
    counter += 1;

    return User.create({
        username: `user${counter}`,
        email: `user${counter}@example.test`,
        password: CryptoJS.AES.encrypt(TEST_PASSWORD, process.env.SECRET_KEY).toString(),
        defaultCurrency: 'USD',
        ...overrides
    });
}

function seedFund(user, overrides = {}) {
    return Fund.create({
        name: 'Wallet',
        userId: user._id,
        initialBalance: 1000,
        currentBalance: 1000,
        currency: 'USD',
        ...overrides
    });
}

function seedCategory(user, overrides = {}) {
    return Category.create({
        name: 'Food',
        icon: 'mdi-food',
        user: user ? user._id : null,
        ...overrides
    });
}

function tokenFor(user) {
    return generateAccessToken({ username: user.username, email: user.email, id: user._id.toString() });
}

function expiredTokenFor(user) {
    return jwt.sign(
        { username: user.username, email: user.email, id: user._id.toString() },
        process.env.SECRET_KEY,
        { expiresIn: -10 }
    );
}

function bearer(user) {
    return { Authorization: `Bearer ${tokenFor(user)}` };
}

function cookieFor(user) {
    return `refreshToken=${generateRefreshToken(user._id.toString())}`;
}

function botHeaders(telegramId, secret = process.env.TELEGRAM_BOT_SECRET) {
    const headers = { 'X-Telegram-Bot-Secret': secret };

    if (telegramId !== undefined) {
        headers['X-Telegram-User-Id'] = String(telegramId);
    }

    return headers;
}

module.exports = {
    TEST_PASSWORD,
    seedUser,
    seedFund,
    seedCategory,
    tokenFor,
    expiredTokenFor,
    bearer,
    cookieFor,
    botHeaders
};
