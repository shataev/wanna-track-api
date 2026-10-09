const dotenv = require('dotenv');

// Before app.js is required: it reads CLIENT_URL when it builds the CORS config
dotenv.config();

const mongoose = require('mongoose');
const app = require('./app');
const { startExchangeRateCron } = require("./jobs/exchangeRateCron");

const PORT = process.env.PORT || 8900;

// Start exchange rate cron job
startExchangeRateCron();

async function start() {
    try {
      await mongoose.connect(process.env.MONGO_URL);
      console.log("DB successfully connected!");
  
      app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
      });
  
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }
  
  start();
