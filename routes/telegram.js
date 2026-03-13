const router = require('express').Router();
const crypto = require('crypto');
const { checkAccessToken } = require('../middlewares/checkAuth');
const { checkTelegramBotSecret } = require('../middlewares/checkTelegramBotSecret');
const TelegramBindingToken = require('../models/TelegramBindingToken');
const User = require('../models/User');

// Get link to bind Telegram account (user must be authenticated)
router.get('/telegram-binding-link', checkAccessToken, async (req, res) => {
  try {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME;

    if (!botUsername) {
      return res.status(500).json({
        message: 'Telegram bot is not configured (TELEGRAM_BOT_USERNAME)',
      });
    }

    const userId = req.user.id;
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + TelegramBindingToken.BINDING_TOKEN_EXPIRY_MINUTES * 60 * 1000);

    await TelegramBindingToken.create({
      token,
      user: userId,
      expiresAt,
    });

    const payload = `bind_${token}`;
    const link = `https://t.me/${botUsername.replace(/^@/, '')}?start=${payload}`;

    res.status(200).json({
      link,
      expiresInMinutes: TelegramBindingToken.BINDING_TOKEN_EXPIRY_MINUTES,
    });
  } catch (error) {
    console.error('[telegram-binding-link]', error);
    res.status(500).json({ message: 'Failed to generate binding link' });
  }
});

// Called by the Telegram bot to complete binding (token from start payload, telegramId from bot context)
router.post('/telegram-bind', checkTelegramBotSecret, async (req, res) => {
  try {
    const { token: rawToken, telegramId } = req.body;
    const token = rawToken?.startsWith('bind_') ? rawToken.slice(5) : rawToken;

    if (!token || !telegramId) {
      return res.status(400).json({
        message: 'Missing token or telegramId',
      });
    }

    const binding = await TelegramBindingToken.findOne({
      token,
      expiresAt: { $gt: new Date() },
    }).populate('user');

    if (!binding) {
      return res.status(400).json({
        message: 'Invalid or expired binding token',
      });
    }

    const user = await User.findByIdAndUpdate(
      binding.user._id,
      { telegramId: String(telegramId) },
      { new: true }
    );

    await TelegramBindingToken.deleteOne({ _id: binding._id });

    res.status(200).json({
      success: true,
      userId: user._id,
      telegramId: user.telegramId,
    });
  } catch (error) {
    console.error('[telegram-bind]', error);
    res.status(500).json({ message: 'Failed to bind Telegram account' });
  }
});

// Get user id by Telegram ID (for bot use; requires x-telegram-bot-secret header)
router.get('/user-by-telegram/:telegramId', checkTelegramBotSecret, async (req, res) => {
  try {
    const { telegramId } = req.params;
    if (!telegramId) {
      return res.status(400).json({ message: 'Missing telegramId' });
    }

    const user = await User.findOne({ telegramId: String(telegramId) }).select('_id').lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found for this Telegram ID' });
    }

    res.status(200).json({ id: user._id.toString() });
  } catch (error) {
    console.error('[user-by-telegram]', error);
    res.status(500).json({ message: 'Failed to get user by Telegram ID' });
  }
});

// Unbind Telegram account from the authenticated user
router.post('/telegram-unbind', checkAccessToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByIdAndUpdate(
      userId,
      { $unset: { telegramId: 1 } },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Telegram account unbound',
      telegramId: undefined,
    });
  } catch (error) {
    console.error('[telegram-unbind]', error);
    res.status(500).json({ message: 'Failed to unbind Telegram account' });
  }
});

module.exports = router;
