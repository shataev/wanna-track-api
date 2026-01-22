const mongoose = require("mongoose");

const ExchangeRateSchema = new mongoose.Schema(
  {
    base: {
      type: String,
      required: true,
      default: "USD"
    },
    rates: {
      type: Map,
      of: Number,
      required: true
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ExchangeRate", ExchangeRateSchema);

