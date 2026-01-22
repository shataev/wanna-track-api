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
