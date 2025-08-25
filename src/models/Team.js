const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    code: {
      type: String,
      required: true,
    },
    alternate_name: String,
    alternate_code: String,
    gender_name: String,
    country_code: String,
    type: {
      type: String,
      enum: ['international', 'domestic', 'league', 'club'],
    },
    logo_url: String,
    players: [
      {
        key: String,
        name: String,
        playing_role: String,
        batting_style: String,
        bowling_style: String,
        captain: Boolean,
        keeper: Boolean,
      },
    ],
    recent_matches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Match',
      },
    ],
    upcoming_matches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Match',
      },
    ],
    last_updated: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Team', teamSchema); 