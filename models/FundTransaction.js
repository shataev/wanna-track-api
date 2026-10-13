const mongoose = require("mongoose");
const {Schema} = require("mongoose");

const FundTransactionSchema = new mongoose.Schema({
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fundId: { type: Schema.Types.ObjectId, ref: 'Fund', required: true },
    type: { type: String, enum: ['income', 'expense', 'adjustment', 'transfer-in', 'transfer-out', 'refund'], required: true },
    amount: { type: Number, required: true },
    description: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('FundTransaction', FundTransactionSchema);
