const mongoose = require("mongoose");
const {Schema} = require("mongoose");

const CostSchema = new mongoose.Schema(
    {
        amount: {
            type: Number,
            required: true,
        },
        currency: {
            type: String,
            required: true,
        },
        rate: {
            type: Number,
            required: true,
        },
        category: {
            type: Schema.Types.ObjectId,
            ref: "Category",
            required: true,
        },
        fund: {
            type: Schema.Types.ObjectId,
            ref: 'Fund',
            default: null
        },
        date: {
            type: Date,
            required: true
        },
        comment: {
            type: String,
        },
        user: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        // Contexts across categories, such as a trip; normalised by utils/tag.utils
        tags: {
            type: [String],
            default: []
        },
        // What was debited from the fund, in the fund's currency; only set when a fund is attached.
        // Costs saved before it existed lack it and were debited exactly `amount`
        fundAmount: {
            type: Number
        }
    },
    {
        timestamps: true
    }
);

CostSchema.index({ user: 1, tags: 1 });

module.exports = mongoose.model('Cost', CostSchema);
