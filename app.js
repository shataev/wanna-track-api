const express = require('express');
const authRoute = require('./routes/auth');
const telegramRoute = require('./routes/telegram');
const costRoute = require('./routes/cost');
const verifyRoute = require('./routes/verify');
const categoryRoute = require('./routes/category');
const fundsRoute = require('./routes/fund');
const exchangeRatesRoute = require('./routes/exchange-rates');
const meRoute = require('./routes/me');
const cors = require('cors');
const cookieParser = require("cookie-parser");

// Builds the app only: connecting to the database, the cron and listen live in index.js,
// so tests can mount the app against an in-memory MongoDB

const app = express();

// CORS set up
const ORIGIN = process.env.stage === 'development' ? 'http://localhost:5173' : process.env.CLIENT_URL;

app.use(cookieParser());
app.use(cors({
    origin: ORIGIN,
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-verification-code'],
    credentials: true,
    maxAge: 600,
    exposedHeaders: ['*', 'Authorization' ]
}));

// Built-in middleware for request body parsing
app.use(express.json());

// Routes
app.use('/api/auth', authRoute);
app.use('/api/telegram', telegramRoute);
app.use('/api', [costRoute, categoryRoute, fundsRoute, meRoute]);
app.use('/api/verify', verifyRoute);
app.use('/api/exchange-rates', exchangeRatesRoute);

module.exports = app;
