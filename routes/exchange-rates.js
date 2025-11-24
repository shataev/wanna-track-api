const router = require('express').Router();
const { getRates, updateRates } = require('../services/exchangeRateService');

// GET /api/exchange-rates/current — вернуть актуальные курсы
router.get('/current', async (req, res) => {
  try {
    const exchangeRate = await getRates();
    
    if (!exchangeRate) {
      return res.status(404).json({
        error: 'Exchange rates not found. Please update rates first.'
      });
    }

    // Преобразуем Map в обычный объект для JSON ответа
    const ratesObject = {};
    if (exchangeRate.rates instanceof Map) {
      exchangeRate.rates.forEach((value, key) => {
        ratesObject[key] = value;
      });
    } else {
      // Если rates уже объект (например, после сохранения)
      Object.assign(ratesObject, exchangeRate.rates);
    }

    // Добавляем базовую валюту в rates с курсом 1
    ratesObject[exchangeRate.base] = 1;

    res.status(200).json({
      base: exchangeRate.base,
      rates: ratesObject,
      updatedAt: exchangeRate.updatedAt
    });
  } catch (error) {
    console.error('Error getting exchange rates:', error);
    res.status(500).json({
      error: 'Failed to retrieve exchange rates',
      message: error.message
    });
  }
});

// POST /api/exchange-rates/update — вручную обновить курсы
router.post('/update', async (req, res) => {
  try {
    const updatedRates = await updateRates();
    
    // Преобразуем Map в обычный объект для JSON ответа
    const ratesObject = {};
    if (updatedRates.rates instanceof Map) {
      updatedRates.rates.forEach((value, key) => {
        ratesObject[key] = value;
      });
    } else {
      Object.assign(ratesObject, updatedRates.rates);
    }

    // Добавляем базовую валюту в rates с курсом 1
    ratesObject[updatedRates.base] = 1;

    res.status(200).json({
      message: 'Exchange rates updated successfully',
      base: updatedRates.base,
      rates: ratesObject,
      updatedAt: updatedRates.updatedAt
    });
  } catch (error) {
    console.error('Error updating exchange rates:', error);
    res.status(500).json({
      error: 'Failed to update exchange rates',
      message: error.message
    });
  }
});

module.exports = router;

