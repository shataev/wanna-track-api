const mongoose = require("mongoose");
const {Schema} = require("mongoose");

// A signed-in device: the web's refresh cookie names it by a secret of which only the sha256 is stored.
// One document per sign-in; refreshing rotates the secret inside it, so revoking it ends the whole family
const SessionSchema = new mongoose.Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    // sha256 of the secret in the cookie now
    tokenHash: {
      type: String,
      required: true,
      index: true
    },
    // Random, the same across rotations
    family: {
      type: String,
      required: true
    },
    // sha256 of the secret the last rotation replaced: still accepted for a few seconds, a reuse after that
    previousHash: {
      type: String,
      default: null,
      index: true
    },
    userAgent: {
      type: String,
      default: ''
    },
    // Where it was signed in from
    ip: {
      type: String,
      default: null
    },
    // Set at sign-in and at every rotation, nowhere else: the grace for the previous secret counts from it
    lastUsedAt: {
      type: Date,
      required: true
    },
    // Sliding: moves forward at every refresh, never past absoluteExpiresAt
    expiresAt: {
      type: Date,
      required: true
    },
    absoluteExpiresAt: {
      type: Date,
      required: true
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

// MongoDB removes a session 30 days after it can no longer be used in any case
SessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('Session', SessionSchema);
