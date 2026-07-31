const crypto = require('crypto');

/**
 * Requires the x-telegram-bot-secret header to match TELEGRAM_BOT_SECRET.
 * Guards the routes only the bot is allowed to call: /api/telegram/telegram-bind
 * and /api/telegram/user-by-telegram/:telegramId.
 *
 * A missing TELEGRAM_BOT_SECRET is a misconfiguration, not permission to skip
 * the check — without it those routes would be open to anyone.
 */
const isSecretValid = (provided, expected) => {
  if (typeof provided !== 'string' || provided.length !== expected.length) {
    return false;
  }

  // Constant-time compare, so the response time gives nothing away
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
};

const checkTelegramBotSecret = (req, res, next) => {
  const secret = process.env.TELEGRAM_BOT_SECRET;

  if (!secret) {
    console.error('[checkTelegramBotSecret] TELEGRAM_BOT_SECRET is not set, rejecting the request');

    return res.status(500).json({ message: 'Telegram bot integration is not configured' });
  }

  if (!isSecretValid(req.headers['x-telegram-bot-secret'], secret)) {
    return res.status(403).json({ message: 'Forbidden: invalid or missing bot secret' });
  }

  next();
};

module.exports = { checkTelegramBotSecret };
