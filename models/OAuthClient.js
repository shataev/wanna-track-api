const mongoose = require("mongoose");

// A client registered through OAuth dynamic client registration (RFC 7591). Public clients only:
// there is never a client secret. Only the fields the server needs are kept, whatever the client sent
const OAuthClientSchema = new mongoose.Schema(
  {
    clientId: {
      type: String,
      required: true,
      unique: true
    },
    clientName: {
      type: String,
      default: null
    },
    redirectUris: {
      type: [String],
      required: true
    },
    clientIdIssuedAt: {
      type: Number,
      required: true
    },
    // When a client nobody has allowed yet is deleted, so registrations nobody completes do not pile up;
    // null once a user allows the client
    pendingUntil: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

// MongoDB deletes a client nobody granted access to once pendingUntil has passed
OAuthClientSchema.index({ pendingUntil: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OAuthClient', OAuthClientSchema);
