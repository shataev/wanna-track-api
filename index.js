const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const authRoute = require('./routes/auth');
const costRoute = require('./routes/cost');
const verifyRoute = require('./routes/verify');
const categoryRoute = require('./routes/category');
const fundsRoute = require('./routes/fund');
const exchangeRatesRoute = require('./routes/exchange-rates');
const cors = require('cors');
const cookieParser = require("cookie-parser");
const {Telegraf} = require("telegraf");
const {initBot} = require("./telagramBot");
const { startExchangeRateCron } = require("./jobs/exchangeRateCron");

const PORT = process.env.PORT || 8900;

dotenv.config();

mongoose.connect(process.env.MONGO_URL)
  .then(() => {
      console.log('DB successfully connected!')
  })
  .catch(e => {
      console.log(e)
  })

const app = express();

// CORS set up
const ORIGIN = process.env.stage === 'development' ? 'http://localhost:5173' : process.env.CLIENT_URL;

app.use(cookieParser());
app.use(cors({
    origin: ORIGIN,
    methods: ['GET', 'PUT', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-verification-code'],
    credentials: true,
    maxAge: 600,
    exposedHeaders: ['*', 'Authorization' ]
}));

// Built-in middleware for request body parsing
app.use(express.json());

// Routes
app.use('/api/auth', authRoute);
app.use('/api', [costRoute, categoryRoute, fundsRoute]);
app.use('/api/verify', verifyRoute);
app.use('/api/exchange-rates', exchangeRatesRoute);

// Telegram bot
initBot();

// Start exchange rate cron job
startExchangeRateCron();

// Server starting
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})
