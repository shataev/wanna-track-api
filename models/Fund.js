const mongoose = require("mongoose");
const {Schema} = require("mongoose");

const FundSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    icon: {
      type: String,
      default: null
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User"
    },
    description: { type: String, default: '' },
    initialBalance: { type: Number, required: true },
    currentBalance: { type: Number, required: true },
    isDefault: { type: Boolean, default: false },
    // 'account' is money to spend from, 'savings' a separate real balance; funds saved before have no kind and are accounts
    kind: { type: String, enum: ['account', 'savings'], default: 'account' },
    // Optional goal of a savings fund, in the fund's own currency
    goal: {
      type: new Schema({
        amount: { type: Number, required: true, min: 0, validate: { validator: (v) => v > 0 } },
        date: { type: Date, default: null }
      }, { _id: false }),
      default: null
    },
    // When the fund was archived; null (or missing, for funds saved before) means active
    archivedAt: { type: Date, default: null },
    currency: {
      type: String,
      required: true,
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true
  }
);

FundSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Fund', FundSchema);
