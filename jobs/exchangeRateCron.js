const cron = require('node-cron');
const { updateRates } = require('../services/exchangeRateService');

// Настройка cron job для обновления курсов валют каждый день в 1:00 AM
// Формат: секунда минута час день месяц день_недели
// '0 1 * * *' означает: в 0 секунд, 1 минуту, каждый час, каждый день, каждый месяц, каждый день недели
// То есть каждый день в 01:01:00 (1:01 AM)
// Если нужно точно в 1:00 AM, используем '0 0 1 * * *'

function startExchangeRateCron() {
  // Обновление курсов каждый день в 1:00 AM
  // Формат cron: секунда минута час день месяц день_недели
  cron.schedule('0 0 1 * * *', async () => {
    try {
      console.log('[Cron Job] Starting exchange rates update at 1:00 AM...');
      await updateRates();
      console.log('[Cron Job] Exchange rates updated successfully');
    } catch (error) {
      console.error('[Cron Job] Error updating exchange rates:', error.message);
    }
  }, {
    scheduled: true,
    timezone: "UTC" // Можно изменить на нужный часовой пояс, например "Europe/Moscow"
  });

  console.log('Exchange rate cron job scheduled: daily at 1:00 AM UTC');
}

module.exports = { startExchangeRateCron };

