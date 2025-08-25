const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
    },
    content: {
      type: String,
      required: true,
    },
    summary: String,
    image_url: String,
    published_at: {
      type: Date,
      default: Date.now,
    },
    author: {
      name: String,
      role: String,
    },
    category: {
      type: String,
      enum: ['match-report', 'preview', 'feature', 'opinion', 'interview', 'news', 'stats'],
      default: 'news',
    },
    tags: [String],
    related_matches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Match',
      },
    ],
    related_teams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Team',
      },
    ],
    related_tournaments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tournament',
      },
    ],
    featured: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'published',
    },
  },
  {
    timestamps: true,
  }
);

// Create index for search
newsSchema.index({ title: 'text', content: 'text', summary: 'text', tags: 'text' });

module.exports = mongoose.model('News', newsSchema); 