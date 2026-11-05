const mongoose = require('mongoose');
const { Schema } = mongoose;

// A monthly limit for one category of one user. Not a field on Category: a global category (user: null)
// is shared by every user, so a limit stored there would be everyone's.
// An overall limit can be added later as a budget without a category; nothing here prevents it.
const BudgetSchema = new Schema(
    {
        user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        category: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
        amount: { type: Number, required: true, validate: { validator: v => Number.isFinite(v) && v > 0, message: 'Amount must be positive' } },
        // The user's default currency when the limit was set
        currency: { type: String, required: true }
    },
    { timestamps: true }
);

BudgetSchema.index({ user: 1, category: 1 }, { unique: true });

module.exports = mongoose.model('Budget', BudgetSchema);
