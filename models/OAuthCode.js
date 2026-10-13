const mongoose = require("mongoose");
const {Schema} = require("mongoose");

/**
 * A single-use secret of the authorization step, stored as the sha256 of its value:
 * - consent: issued after a correct sign-in, carried by the consent form (the form's CSRF nonce)
 * - code: the authorization code handed to the client's redirect URI
 * Both are bound to the authorization request they were issued for.
 */
const OAuthCodeSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['consent', 'code'],
      required: true
    },
    hash: {
      type: String,
      required: true,
      unique: true
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
    redirectUri: {
      type: String,
      required: true
    },
    codeChallenge: {
      type: String,
      required: true
    },
    state: {
      type: String,
      default: null
    },
    resource: {
      type: String,
      required: true
    },
    // consent: the scopes requested; code: the scopes granted
    scopes: {
      type: [String],
      required: true
    },
    grant: {
      type: Schema.Types.ObjectId,
      ref: "OAuthGrant",
      default: null
    },
    expiresAt: {
      type: Date,
      required: true
    },
    usedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

module.exports = mongoose.model('OAuthCode', OAuthCodeSchema);
