const ExchangeRate = require("../models/ExchangeRate");

async function getRates() {
  try {
    const rates = await ExchangeRate.findOne();
    if (!rates) {
      console.log("Exchange rates not found in database");
      return null;
    }
    console.log("Exchange rates retrieved successfully");
    return rates;
  } catch (error) {
    console.error("Error getting exchange rates:", error);
    throw error;
  }
}

async function updateRates() {
  try {
    const API_KEY = process.env.EXCHANGE_RATE_API_KEY;
    if (!API_KEY) {
      throw new Error("EXCHANGE_RATE_API_KEY is not set in environment variables");
    }

    const API_URL = `https://api.exchangerate.host/live?access_key=${API_KEY}`;
    
    console.log("Fetching exchange rates from exchangerate.host API...");
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error(`API request failed with status: ${response.status}`);
    }

    const data = await response.json();

    // Проверка успешности запроса (exchangerate.host возвращает поле success)
    if (!data.success) {
      throw new Error(`API returned error: ${data.error?.info || "Unknown error"}`);
    }

    if (!data.source || !data.quotes) {
      throw new Error("Invalid response format from API");
    }

    // exchangerate.host возвращает source (базовая валюта) и quotes (объект с парами валют типа USDTHB)
    const base = data.source;
    // Преобразуем quotes в формат Map, где ключ - код валюты без префикса base
    const rates = new Map();
    for (const [key, value] of Object.entries(data.quotes)) {
      // Убираем префикс базовой валюты (например, USDTHB -> THB)
      const currency = key.replace(base, "");
      rates.set(currency, value);
    }

    const result = await ExchangeRate.findOneAndUpdate(
      {},
      { base, rates, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    console.log(`Exchange rates updated successfully. Base currency: ${base}, Rates count: ${rates.size}`);
    return result;
  } catch (error) {
    console.error("Error updating exchange rates:", error.message);
    throw error;
  }
}

module.exports = { getRates, updateRates };

