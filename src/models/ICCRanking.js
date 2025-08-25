const mongoose = require('mongoose');

const iccRankingSchema = new mongoose.Schema({
  // Common fields
  category: {
    type: String,
    required: true,
    enum: ['teams', 'batsmen', 'bowlers', 'all-rounder']
  },
  format: {
    type: String,
    required: true,
    enum: ['test', 'odi', 't20']
  },
  gender: {
    type: String,
    required: true,
    enum: ['men', 'women']
  },
  rank: {
    type: Number,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  rating: {
    type: String,
    required: true
  },
  points: {
    type: String,
    required: true
  },
  lastUpdatedOn: {
    type: String,
    required: true
  },
  
  // Player specific fields
  playerId: {
    type: String,
    default: null
  },
  country: {
    type: String,
    default: null
  },
  trend: {
    type: String,
    default: null
  },
  faceImageId: {
    type: String,
    default: null
  },
  
  // Image data (base64 encoded)
  displayImg: {
    type: String,
    default: null
  },
  
  // Team specific fields
  teamId: {
    type: String,
    default: null
  },
  matches: {
    type: String,
    default: null
  },
  imageId: {
    type: String,
    default: null
  },
  
  // Sync tracking
  syncBatch: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
iccRankingSchema.index({ category: 1, format: 1, gender: 1, rank: 1 });
iccRankingSchema.index({ syncBatch: 1 });
iccRankingSchema.index({ category: 1, format: 1, gender: 1 });

// Static method to get rankings with filters
iccRankingSchema.statics.getRankings = function(filters = {}) {
  const query = {};
  
  if (filters.category) query.category = filters.category;
  if (filters.format) query.format = filters.format;
  if (filters.gender) query.gender = filters.gender;
  
  return this.find(query)
    .sort({ rank: 1 })
    .select('-__v -createdAt -updatedAt -syncBatch');
};

// Static method to get latest sync info
iccRankingSchema.statics.getLatestSyncInfo = function() {
  return this.findOne()
    .sort({ createdAt: -1 })
    .select('syncBatch createdAt')
    .lean();
};

// Static method to clear old rankings and insert new ones
iccRankingSchema.statics.replaceRankings = async function(newRankings, syncBatch) {
  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      // Delete all existing rankings
      await this.deleteMany({}, { session });
      
      // Insert new rankings
      await this.insertMany(newRankings.map(ranking => ({
        ...ranking,
        syncBatch,
        createdAt: new Date(),
        updatedAt: new Date()
      })), { session });
    });
  } finally {
    await session.endSession();
  }
};

module.exports = mongoose.model('ICCRanking', iccRankingSchema); 