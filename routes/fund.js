const router = require('express').Router();
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const {checkAccessToken} = require('../middlewares/checkAuth');
const { getRates } = require('../services/exchangeRateService');
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

// Get all user's funds
router.get('/funds', async (req, res) => {
    try {
        const userId = new ObjectId(req.query.userId);

        let funds = await Fund.find({
            userId: userId,
        })

        res
            .status(200)
            .json(funds);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }

})


// Add new fund
router.post('/funds', async (req, res) => {
    const {
        name,
        icon,
        userId,
        description,
        initialBalance,
        isDefault,
        currency
    } = req.body;

    try {
        const newFund = new Fund({
            name,
            icon,
            description,
            initialBalance,
            currentBalance: initialBalance,
            isDefault,
            currency,
            userId: userId ? new ObjectId(userId) : null
        });

        const fund = await newFund.save();

        res
            .status(201)
            .json(fund);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

// Update fund
router.put('/funds/:id', async (req, res) => {
    const {id} = req.params;
    const {name, description, currentBalance, icon, isDefault, currency} = req.body;

    try {
        const oldFund = await Fund.findById(id);

        const fund = await Fund.findByIdAndUpdate(
            id,
            {name, description, currentBalance, icon, isDefault, currency},
            {new: true}
        );

        if (!fund) {
            return res.status(404).json({error: 'Fund is not found'});
        }

        // Create Transaction to adjust the balance
        const adjustment = new FundTransaction({
            userId: fund.userId,
            fundId: fund.id,
            type: 'adjustment',
            amount: fund.currentBalance - oldFund.currentBalance,
            description: 'Manual adjustment',
        });
        await adjustment.save();

        res.status(200).json(fund);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

// Delete fund
router.delete('/funds/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const fund = await Fund.findByIdAndDelete(id);

        if (!fund) {
            return res.status(404).json({ error: 'Fund not found' });
        }

        await FundTransaction.deleteMany({ fundId: id });

        res.status(200).json({ message: 'Fund deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Transfer funds between two funds
router.post('/funds/transfer', 
    [
        checkAccessToken,
        async (req, res) => {
            const {fromFundId, toFundId, amount, description} = req.body;
            const userId = req.user.id;

            try {
                if (fromFundId === toFundId) {
                    return res.status(400).json({error: 'Funds must be different'});
                }

                // Find both funds and check ownership in a single query
                const funds = await Fund.find({
                    _id: { $in: [fromFundId, toFundId] },
                    userId
                });

                if (funds.length !== 2) {
                    return res.status(404).json({error: 'One or both funds not found or you don\'t have access to them'});
                }

                const fromFund = funds.find(fund => fund._id.toString() === fromFundId);
                const toFund = funds.find(fund => fund._id.toString() === toFundId);

                if (fromFund.currentBalance < amount) {
                    return res.status(400).json({error: 'Insufficient amount of money in source fund'});
                }

                //return res.status(200).json({message: `fromFund: ${fromFund}, toFund: ${toFund}`})

                // Create Transactions for each funds
                const outgoingTransaction = new FundTransaction({
                    userId,
                    fundId: fromFundId,
                    type: 'transfer-out',
                    amount: -amount,
                    description,
                });
                await outgoingTransaction.save();

                const incomingTransaction = new FundTransaction({
                    userId,
                    fundId: toFundId,
                    type: 'transfer-in',
                    amount,
                    description,
                });
                await incomingTransaction.save();

                // Update funds
                await Fund.findByIdAndUpdate(fromFundId, {$inc: {currentBalance: -amount}});
                await Fund.findByIdAndUpdate(toFundId, {$inc: {currentBalance: amount}});

                res.status(200).json("Transferred successfully!");
            } catch (error) {
                res.status(500).json({error: error.message});
            }
        }
    ]
);

// GET /api/funds/total — вернуть общую сумму по всем фондам в базовой валюте пользователя
router.get('/funds/total', 
    [
        checkAccessToken,
        async (req, res) => {
            try {
                const userId = new ObjectId(req.user.id);
                const userCurrency = req.user.defaultCurrency || 'USD';

                // Получаем все фонды пользователя
                const funds = await Fund.find({ userId });

                if (funds.length === 0) {
                    return res.status(200).json({
                        total: 0,
                        baseCurrency: userCurrency,
                        fundsCount: 0
                    });
                }

                // Получаем курсы валют
                const exchangeRates = await getRates();
                
                if (!exchangeRates) {
                    return res.status(404).json({
                        error: 'Exchange rates not found. Please update rates first.'
                    });
                }

                // Преобразуем Map в объект для удобства работы
                const rates = {};
                if (exchangeRates.rates instanceof Map) {
                    exchangeRates.rates.forEach((value, key) => {
                        rates[key] = value;
                    });
                } else {
                    Object.assign(rates, exchangeRates.rates);
                }

                const systemBaseCurrency = exchangeRates.base; // Обычно USD
                let totalInSystemBase = 0; // Сумма в системной базовой валюте (USD)

                // Конвертируем каждый баланс в системную базовую валюту (USD)
                for (const fund of funds) {
                    const fundCurrency = fund.currency;
                    const fundBalance = fund.currentBalance;

                    if (fundCurrency === systemBaseCurrency) {
                        // Если валюта фонда совпадает с системной базовой, просто добавляем баланс
                        totalInSystemBase += fundBalance;
                    } else {
                        // Конвертируем в системную базовую валюту
                        // Курс хранится как: 1 системная базовая валюта = X целевая валюта
                        // Поэтому для конвертации: баланс / курс
                        const rate = rates[fundCurrency];
                        
                        if (!rate) {
                            console.warn(`Exchange rate not found for currency: ${fundCurrency}`);
                            // Если курс не найден, пропускаем этот фонд
                            continue;
                        }

                        const convertedBalance = fundBalance / rate;
                        totalInSystemBase += convertedBalance;
                    }
                }

                // Теперь конвертируем из системной базовой валюты в валюту пользователя
                let total = totalInSystemBase;
                if (userCurrency !== systemBaseCurrency) {
                    const userCurrencyRate = rates[userCurrency];
                    if (!userCurrencyRate) {
                        console.warn(`Exchange rate not found for user currency: ${userCurrency}`);
                        // Если курс не найден, возвращаем в системной базовой валюте
                        total = totalInSystemBase;
                    } else {
                        // Конвертируем: сумма в USD * курс валюты пользователя
                        total = totalInSystemBase * userCurrencyRate;
                    }
                }

                res.status(200).json({
                    total: Math.round(total * 100) / 100, // Округляем до 2 знаков после запятой
                    baseCurrency: userCurrency,
                    fundsCount: funds.length
                });
            } catch (error) {
                console.error('Error calculating total funds:', error);
                res.status(500).json({
                    error: 'Failed to calculate total funds',
                    message: error.message
                });
            }
        }
    ]);

// GET /api/funds/:id
router.get('/funds/:id', async (req, res) => {
    const {id} = req.params;

    try {
        const fund = await Fund.findById(id);
        if (!fund) {
            return res.status(404).json({error: 'Fund is not found'});
        }

        res.json({
            id: fund._id,
            name: fund.name,
            icon: fund.icon,
            description: fund.description,
            initialBalance: fund.initialBalance,
            currentBalance: fund.currentBalance,
            createdAt: fund.createdAt,
            updatedAt: fund.updatedAt,
            isDefault: fund.isDefault,
            currency: fund.currency,
        });
    } catch (error) {
        console.error('Get fund error:', error);
        res.status(500).json({error: error.message});
    }
});

// Get all transactions for a fund
router.get('/funds/:id/transactions', async (req, res) => {
    const {id} = req.params;

    try {
        const transactions = await FundTransaction.find({fundId: id});
        res.status(200).json(transactions);
    } catch (error) {
        res.status(500).json({error: error.message});
    }
});

module.exports = router;
