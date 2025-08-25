const mongoose = require('mongoose');

const CountrySchema = new mongoose.Schema({
  short_code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    maxlength: 2,
  },
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    maxlength: 3,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  official_name: {
    type: String,
    trim: true,
    default: null,
  },
  flagSvg: {
    type: String,
    required: true,
  }
}, {
  timestamps: true,
  versionKey: false,
});

CountrySchema.index({ code: 1 });
CountrySchema.index({ short_code: 1 });

module.exports = mongoose.model('Country', CountrySchema); 