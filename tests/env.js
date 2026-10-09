// Runs before any test module is required: route and middleware modules read some of these at load time.
// Placeholder values for tests only.
process.env.SECRET_KEY = 'test-access-secret';
process.env.SECRET_KEY_REFRESH = 'test-refresh-secret';
process.env.TELEGRAM_BOT_SECRET = 'test-bot-secret';
process.env.TELEGRAM_BOT_USERNAME = 'test_bot';
process.env.CLIENT_URL = 'http://client.test';
delete process.env.AUTH_ENFORCE;
delete process.env.ADMIN_SECRET;
