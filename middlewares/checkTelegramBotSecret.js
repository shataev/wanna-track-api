/**
 * Optional middleware: if TELEGRAM_BOT_SECRET is set, requires x-telegram-bot-secret header to match.
 * Used for POST /api/auth/telegram-bind so only your bot can confirm bindings.
 */
const checkTelegramBotSecret = (req, res, next) => {
  const secret = process.env.TELEGRAM_BOT_SECRET;
  if (!secret) {
    return next();
  }
  const headerSecret = req.headers['x-telegram-bot-secret'];
  if (headerSecret !== secret) {
    return res.status(403).json({ message: 'Forbidden: invalid or missing bot secret' });
  }
  next();
};

module.exports = { checkTelegramBotSecret };
