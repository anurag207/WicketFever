const mongoose = require('mongoose');

const bestPerformersSchema = new mongoose.Schema(
  {
    match_key: {
      type: String,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['batters', 'bowling'],
      required: true,
    },
    data: {
      batters: [{
        player_key: String,
        name: String,
        team: String,
        team_name: String,
        opponent: String,
        runs: Number,
        balls: Number,
        fours: Number,
        sixes: Number,
        strike_rate: Number,
        control_percentage: Number,
        best_shot: String,
        average_shot: String,
        boundary_percentage: Number,
        dot_ball_percentage: Number,
        player_image: String,
        active_overs: [{
          start: [Number], // [over, ball]
          end: [Number],   // [over, ball]
          partnership_runs: Number
        }]
      }],
      bowlers: [{
        player_key: String,
        name: String,
        team: String,
        team_name: String,
        opponent: String,
        overs: String,
        maidens: Number,
        runs: Number,
        wickets: Number,
        economy: Number,
        dot_balls: Number,
        wides: Number,
        no_balls: Number,
        wicket_types: [String],
        ball_type_breakdown: {
          normal: Number,
          wide: Number,
          no_ball: Number
        },
        wickets_breakup: {
          bowled: Number,
          caught: Number,
          lbw: Number,
          stumping: Number
        },
        stats: {
          boundary_percentage: Number,
          boundary_frequency: Number,
          dot_ball_percentage: Number,
          dot_ball_frequency: Number
        },
        player_image: String
      }]
    },
    match_status: String,
    last_updated: {
      type: Date,
      default: Date.now,
    },
    cache_expires_at: {
      type: Date,
      required: true,
    }
  },
  {
    timestamps: true,
  }
);

// Compound index for efficient querying
bestPerformersSchema.index({ match_key: 1, type: 1 }, { unique: true });
// Index for cache expiration
bestPerformersSchema.index({ cache_expires_at: 1 });

module.exports = mongoose.model('BestPerformers', bestPerformersSchema); 