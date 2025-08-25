const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema(
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
    short_name: {
      type: String,
      required: true,
    },
    sub_title: String,
    status: {
      type: String,
      enum: ['not_started', 'started', 'completed', 'abandoned', 'cancelled'],
      required: true,
    },
    start_at: {
      type: Number,
      required: true,
    },
    tournament: {
      key: String,
      name: String,
      short_name: String,
      alternate_name: String,
      alternate_short_name: String,
    },
    format: {
      type: String,
      enum: ['test', 't20', 'oneday'],
    },
    gender: {
      type: String,
      enum: ['male', 'female'],
    },
    teams: {
      a: {
        key: String,
        code: String,
        name: String,
        alternate_name: String,
        alternate_code: String,
        gender_name: String,
        country_code: String,
        flag: String,
      },
      b: {
        key: String,
        code: String,
        name: String,
        alternate_name: String,
        alternate_code: String,
        gender_name: String,
        country_code: String,
        flag: String,
      },
    },
    venue: {
      key: String,
      name: String,
      city: String,
      country: {
        short_code: String,
        code: String,
        name: String,
        official_name: String,
        is_region: Boolean,
      },
      geolocation: String,
    },
    winner: String,
    metric_group: String,
    sport: {
      type: String,
      default: 'cricket',
    },
    estimated_end_date: Number,
    completed_date_approximate: Number,
    
    // Store the complete play data from API (includes innings, toss, result, etc.)
    play: {
      first_batting: String,
      day_number: Number,
      overs_per_innings: [Number],
      reduced_overs: mongoose.Schema.Types.Mixed,
      target: {
        balls: Number,
        runs: Number,
        dl_applied: Boolean,
      },
      result: {
        pom: [String], // Player of the Match
        winner: String,
        result_type: String,
        win_by: Number,
        msg: String,
      },
      innings_order: [String],
      // Store innings data as received from API - object with dynamic keys like "b_1", "a_1", etc.
      innings: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
      },
    },
    
    // Store toss information
    toss: {
      called: String,
      winner: String,
      elected: String,
      squad_announced: Boolean,
    },
    
    // Store players data from API response
    players: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    
    // Add other API fields that might be present
    expected_start_at: Number,
    start_at_local: Number,
    title: String,
    play_status: String,
    tour_key: String,
    association: {
      key: String,
      code: String,
      name: String,
      country: mongoose.Schema.Types.Mixed,
      parent: mongoose.Schema.Types.Mixed,
    },
    messages: [mongoose.Schema.Types.Mixed],
    
    score_summary: {
      a: String,
      b: String,
    },
    last_updated: {
      type: Date,
      default: Date.now,
    },
    raw_data: {
      type: Object,
      select: false,
    },

    scorecard: {
      type: Object,
      select: false, // Don't include in normal queries by default
    },
  },
  {
    timestamps: true,
  }
);

matchSchema.index({ status: 1, last_updated: -1 });
// Index for tournament-based queries
matchSchema.index({ 'tournament.key': 1 });

module.exports = mongoose.model('Match', matchSchema); 