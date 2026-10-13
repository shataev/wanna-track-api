// Runs before any test module is required: route and middleware modules read some of these at load time.
// Placeholder values for tests only.
process.env.SECRET_KEY = 'test-access-secret';
process.env.SECRET_KEY_REFRESH = 'test-refresh-secret';
process.env.TELEGRAM_BOT_SECRET = 'test-bot-secret';
process.env.TELEGRAM_BOT_USERNAME = 'test_bot';
process.env.CLIENT_URL = 'http://client.test';
delete process.env.AUTH_ENFORCE;
delete process.env.ADMIN_SECRET;

// Node 18 has a global WebCrypto, but jest's node environment does not pass it into the test sandbox there;
// the SDK's PKCE check needs it. Real Node 18 processes have it (Node 20+ sandboxes do too)
if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto;
}
