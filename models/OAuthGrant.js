const mongoose = require("mongoose");
const {Schema} = require("mongoose");

// What a user allowed one OAuth client to do. Revoking it invalidates every token issued under it
const OAuthGrantSchema = new mongoose.Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    clientId: {
      type: String,
      required: true
    },
    clientName: {
      type: String,
      default: null
    },
    // expenses.read, optionally expenses.write
    scopes: {
      type: [String],
      required: true
    },
    lastUsedAt: {
      type: Date,
      default: null
    },
    revokedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('OAuthGrant', OAuthGrantSchema);
