const Country = require('../models/Country');
const roanuzService = require('./roanuzService');
const cacheService = require('./cacheService');
const { DEFAULT_FLAG_SVG, REDIS_TTL_LONG ,REDIS_TTL_SHORT,REDIS_TTL_MEDIUM,REDIS_TTL_LIVE} = require('../config/constants');

/**
 * Get a country flag SVG by its code
 * @param {string} code - The 3-letter country code
 * @returns {Promise<Object>} - Returns object with flagSvg, ttl, and source
 */
async function getCountryFlagSvg(code) {
  try {
    if (!code || code.length < 2) {
      return {
        flagSvg: DEFAULT_FLAG_SVG,
        ttl: REDIS_TTL_LONG,
        source: 'default'
      };
    }
    
    const normalizedCode = code.toUpperCase();
    const cacheKey = `country_flag_${normalizedCode}`;
    
    let cachedData = await cacheService.get(cacheKey);
    
    if (cachedData) {
      return {
        flagSvg: cachedData,
        ttl: REDIS_TTL_LONG,
        source: 'cache'
      };
    }
    
    const country = await Country.findOne({ code: normalizedCode });
    
    if (country && country.flagSvg) {
      await cacheService.set(cacheKey, country.flagSvg, REDIS_TTL_LONG);
      
      return {
        flagSvg: country.flagSvg,
        ttl: REDIS_TTL_LONG,
        source: 'database'
      };
    }
    
    const apiResponse = await roanuzService.getCountryFlag(normalizedCode);
    
    if (!apiResponse || typeof apiResponse !== 'string' || !apiResponse.includes('<svg')) {
      return {
        flagSvg: DEFAULT_FLAG_SVG,
        ttl: REDIS_TTL_LONG,
        source: 'default'
      };
    }
    
    const flagSvg = apiResponse;
    
    if (country) {
      await Country.findOneAndUpdate(
        { code: normalizedCode },
        { flagSvg },
        { new: true }
      );
    }
    
    const ttl = REDIS_TTL_LONG;
    
    await cacheService.set(cacheKey, flagSvg, ttl);
    
    return {
      flagSvg,
      ttl,
      source: 'api'
    };
  } catch (error) {
    console.error('Error getting country flag:', error);
    
    return {
      flagSvg: DEFAULT_FLAG_SVG,
      ttl: REDIS_TTL_LONG,
      source: 'default',
      error: error.message
    };
  }
}

module.exports = {
  getCountryFlagSvg
}; 