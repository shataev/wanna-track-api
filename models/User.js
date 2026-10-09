const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true
    },
    email: {
      type: String,
      required: true,
      unique: true
    },
    password: {
      type: String,
      required: true,
    },
    verified: {
      type: Boolean,
      default: false
    },
    telegramId: {
      type: String,
      required: false,
    },
    defaultCurrency: {
      type: String,
      required: true,
      default: 'THB'
    },
    // Tag given to every new cost that does not say otherwise, e.g. during a trip
    activeTag: {
      type: String,
      default: null
    },
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('User', UserSchema);
