const mongoose = require("mongoose");
const { Schema } = require("mongoose");

const BINDING_TOKEN_EXPIRY_MINUTES = 15;

const TelegramBindingTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + BINDING_TOKEN_EXPIRY_MINUTES * 60 * 1000),
    },
  },
  {
    timestamps: true,
  }
);

TelegramBindingTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("TelegramBindingToken", TelegramBindingTokenSchema);
module.exports.BINDING_TOKEN_EXPIRY_MINUTES = BINDING_TOKEN_EXPIRY_MINUTES;
