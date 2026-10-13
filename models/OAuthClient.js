const mongoose = require("mongoose");

// A client registered through OAuth dynamic client registration (RFC 7591). Public clients only:
// there is never a client secret
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
    // The registration as returned to the client, handed back to the SDK's handlers as is
    metadata: {
      type: Object,
      required: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('OAuthClient', OAuthClientSchema);
