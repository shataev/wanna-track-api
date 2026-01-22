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
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model('Cost', CostSchema);
