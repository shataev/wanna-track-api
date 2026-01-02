const router = require('express').Router();
const Cost = require('../models/Cost');
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const Fund = require('../models/Fund');
const FundTransaction = require('../models/FundTransaction');
const User = require('../models/User');
const { getRates } = require('../services/exchangeRateService');

// Get all user's costs
router.get('/costs', async (req, res) => {
    try {
        const userId = new ObjectId(req.query.userId);
        const {dateFrom, dateTo} = req.query;

        // Get user's base currency
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        const userCurrency = user.defaultCurrency || 'USD';

        const costs = await Cost.aggregate([
            {
                $match: {
                    $and: [
                        {
                            user: userId,
                        },
                        {
                            createdAt: {
                                $gte: new Date(dateFrom),
                                $lt: new Date(dateTo)
                            }
                        }
                    ]

                },
            },
            {
                $lookup: {
                    from: 'categories',
                    localField: 'category',
                    foreignField: '_id',
                    as: 'category',
                },
            },
            {
                $unwind: '$category',
            },
            {
                $lookup: {
                    from: 'funds',
                    localField: 'fund',
                    foreignField: '_id',
                    as: 'fund'
                }
            },
            {
                $unwind: {
                    path: '$fund',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                // Handle old records without currency/rate: treat as user's base currency
                $addFields: {
                    currency: {
                        $ifNull: ['$currency', userCurrency]
                    },
                    rate: {
                        $ifNull: ['$rate', 1]
                    }
                }
            },
            {
                // Calculate amount in user's base currency: amount * rate
                $addFields: {
                    amountInUserCurrency: {
                        $round: [
                            {
                                $multiply: ['$amount', '$rate']
                            },
                            0
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: '$category._id',
                    amount: { 
                        $sum: '$amountInUserCurrency' // Sum converted amounts
                    },
                    category: {$first: '$category.name'},
                    icon: {$first: '$category.icon'},
                    costs: { 
                        $push: {
                            _id: '$_id',
                            amount: '$amount',
                            currency: '$currency',
                            rate: '$rate',
                            amountInUserCurrency: '$amountInUserCurrency',
                            comment: '$comment',
                            date: '$date',
                            createdAt: '$createdAt',
                            updatedAt: '$updatedAt',
                            fund: '$fund',
                            category: '$category'
                        }
                    },
                }
            },
            {
                // Round the total amount to integer
                $addFields: {
                    amount: {
                        $round: ['$amount', 0]
                    },
                    currency: userCurrency // Add user's base currency to response
                }
            },
            {
                $sort: {
                    amount: -1
                }
            }
        ]);

        res
            .status(200)
            .json(costs);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }

})


// Add new cost
router.post('/cost', async (req, res) => {
    const {
        amount,
        category,
        comment,
        userId,
        date,
        fundId
    } = req.body;

    try {
        let currency = null;
        let rate = null;

        // If fund is provided, get currency from fund and calculate rate
        if (fundId) {
            const fund = await Fund.findById(fundId);
            
            if (!fund) {
                return res.status(404).json({ error: 'Fund not found' });
            }

            if (fund.currentBalance < amount) {
                return res.status(400).json({ error: 'Insufficient funds' });
            }

            // Get currency from fund
            currency = fund.currency;

            // Get user's base currency
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            const userCurrency = user.defaultCurrency || 'USD';

            // Get exchange rates
            const exchangeRates = await getRates();
            if (!exchangeRates) {
                return res.status(404).json({ 
                    error: 'Exchange rates not found. Please update rates first.' 
                });
            }

            // Convert Map to object for easier handling
            const rates = {};
            if (exchangeRates.rates instanceof Map) {
                exchangeRates.rates.forEach((value, key) => {
                    rates[key] = value;
                });
            } else {
                Object.assign(rates, exchangeRates.rates);
            }

            const systemBaseCurrency = exchangeRates.base; // Usually USD

            // Calculate rate from fund currency to user's base currency
            // Rate format: 1 system base currency (USD) = X target currency
            if (currency === userCurrency) {
                // Same currency: rate = 1
                rate = 1;
            } else if (currency === systemBaseCurrency) {
                // Fund currency is system base (USD), user currency is not
                // 1 USD = X userCurrency, so rate = X
                rate = rates[userCurrency] || 1;
            } else if (userCurrency === systemBaseCurrency) {
                // User currency is system base (USD), fund currency is not
                // 1 USD = X fundCurrency, so 1 fundCurrency = 1/X USD
                // Rate = 1 / X
                const fundRate = rates[currency];
                if (!fundRate) {
                    return res.status(400).json({ 
                        error: `Exchange rate not found for currency: ${currency}` 
                    });
                }
                rate = 1 / fundRate;
            } else {
                // Both currencies are different from system base
                // Convert through system base: 1 fundCurrency = (1 / fundRate) * userRate
                // Rate = userRate / fundRate
                const fundRate = rates[currency];
                const userRate = rates[userCurrency];
                
                if (!fundRate) {
                    return res.status(400).json({ 
                        error: `Exchange rate not found for currency: ${currency}` 
                    });
                }
                if (!userRate) {
                    return res.status(400).json({ 
                        error: `Exchange rate not found for user currency: ${userCurrency}` 
                    });
                }
                
                rate = userRate / fundRate;
            }

            // Update fund balance
            fund.currentBalance -= amount;
            await fund.save();

            // Create fund transaction record
            const fundTransaction = new FundTransaction({
                userId: new ObjectId(userId),
                fundId: new ObjectId(fund),
                type: 'expense',
                amount: -amount,
                description: comment || 'Cost payment'
            });
            await fundTransaction.save();
        } else {
            // If no fund is provided, we need currency and rate from request
            // or use user's default currency with rate = 1
            const user = await User.findById(userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            currency = req.body.currency || user.defaultCurrency || 'USD';
            rate = req.body.rate || 1;
        }

        // Create new cost
        const newCost = new Cost({
            amount,
            currency,
            rate,
            category: category,
            comment,
            date,
            user: new ObjectId(userId),
            fund: fundId ? new ObjectId(fundId) : null
        });

        const cost = await newCost.save();

        res
            .status(201)
            .json(cost);
    } catch (error) {
        console.log(error)
        res
            .status(500)
            .json(error);
    }
})

module.exports = router;
