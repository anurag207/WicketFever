const mongoose = require('mongoose');

const tournamentSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  short_name: String,
  alternate_name: String,
  status: {
    type: String,
    enum: ['upcoming', 'ongoing', 'completed'],
    index: true
  },
  start_date: Date,
  end_date: Date,
  association: {
    key: String,
    name: String,
    short_name: String
  },
  format: {
    type: String,
    enum: ['test', 't20', 'oneday']
  },
  gender: {
    type: String,
    enum: ['male', 'female']
  },
  // For special collections like 'featured tournaments', 'associations'
  type: {
    type: String,
    index: true
  },
  last_updated: {
    type: Date,
    default: Date.now
  },
  raw_data: {
    type: Object,
    select: false
  }
}, { timestamps: true });

tournamentSchema.index({ status: 1, last_updated: -1 });
tournamentSchema.index({ key: 1, last_updated: -1 });
tournamentSchema.index({ type: 1, last_updated: -1 });
tournamentSchema.index({ start_date: 1, end_date: 1 });

tournamentSchema.index({ 'raw_data.countries.code': 1, status: 1 });
tournamentSchema.index({ 'raw_data.countries.short_code': 1, status: 1 });
tournamentSchema.index({ status: 1, 'raw_data.countries.code': 1, last_updated: -1 });
tournamentSchema.index({ status: 1, 'raw_data.countries.short_code': 1, last_updated: -1 });

module.exports = mongoose.model('Tournament', tournamentSchema); 