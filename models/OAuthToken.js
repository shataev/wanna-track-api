const mongoose = require("mongoose");
const {Schema} = require("mongoose");

// An opaque OAuth access or refresh token, stored as the sha256 of its value
const OAuthTokenSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['access', 'refresh'],
      required: true
    },
    hash: {
      type: String,
      required: true,
      unique: true
    },
    grant: {
      type: Schema.Types.ObjectId,
      ref: "OAuthGrant",
      required: true,
      index: true
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    clientId: {
      type: String,
      required: true
    },
    // All scopes granted, offline_access included when a refresh token was asked for
    scopes: {
      type: [String],
      required: true
    },
    resource: {
      type: String,
      required: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    // A refresh token is used once: rotating it sets usedAt, and presenting it again revokes the grant
    usedAt: {
      type: Date,
      default: null
    },
    revokedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

// MongoDB removes a day after expiry what can no longer be used
OAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('OAuthToken', OAuthTokenSchema);
