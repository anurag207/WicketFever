const Country = require('../models/Country');
const roanuzService = require('../services/roanuzService');
const cacheService = require('../services/cacheService');
const flagService = require('../services/flagService');
const { DEFAULT_FLAG_SVG ,REDIS_TTL_LONG,REDIS_TTL_MEDIUM,REDIS_TTL_SHORT,REDIS_TTL_LIVE} = require('../config/constants');

/**
 * Get a country flag by its code
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object} - Returns flag SVG with appropriate content type
 */
exports.getCountryFlag = async (req, res) => {
  try {
    const { countryCode } = req.params; 
    
    if (!countryCode || countryCode.length < 2) {
      return res.status(400).json({
        message: 'Invalid country code',
      });
    }
    
    const { flagSvg, ttl, source } = await flagService.getCountryFlagSvg(countryCode);
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', `public, max-age=${ttl}`);
    
    if (source === 'default') {
      res.setHeader('X-Flag-Source', 'default');
      res.setHeader('X-Flag-Message', `No flag found for ${countryCode}, using default`);
    } else {
      res.setHeader('X-Flag-Source', source);
    }
    
    return res.send(flagSvg);
  } catch (error) {
    console.error('Error getting country flag:', error);
    
    return res.status(500).json({
      message: 'Error fetching country flag',
      error: process.env.NODE_ENV === 'production' ? {} : error.message,
    });
  }
};

/**
 * Get all countries
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object} - Returns array of countries
 */
exports.getAllCountries = async (req, res) => {
  try {
    let countries = await Country.find({}, { flagSvg: 0 }).sort({ name: 1 });
    
    if (countries.length === 0) {
      console.log('No countries found in database, syncing from Roanuz...');
      await syncCountriesFromRoanuzInternal();
      countries = await Country.find({}, { flagSvg: 0 }).sort({ name: 1 });
    }
    
    return res.status(200).json({
      countries,
      total: countries.length
    });
  } catch (error) {
    console.error('Error getting countries:', error);
    return res.status(500).json({
      message: 'Error fetching countries',
      error: process.env.NODE_ENV === 'production' ? {} : error.message,
    });
  }
};

/**
 * Sync countries from Roanuz API to MongoDB
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object} - Returns sync result
 */
exports.syncCountriesFromRoanuz = async (req, res) => {
  try {
    const result = await syncCountriesFromRoanuzInternal();
    
    return res.status(200).json({
      message: 'Countries synced successfully',
      ...result
    });
  } catch (error) {
    console.error('Error syncing countries from Roanuz:', error);
    return res.status(500).json({
      message: 'Error syncing countries',
      error: process.env.NODE_ENV === 'production' ? {} : error.message,
    });
  }
};

/**
 * Internal function to sync countries from Roanuz API
 * @returns {Promise<object>} - Returns sync statistics
 */
const syncCountriesFromRoanuzInternal = async () => {
  try {
    console.log('Fetching countries list from Roanuz API...');
    const apiResponse = await roanuzService.getCountriesList();
    
    if (!apiResponse || !apiResponse.data || !apiResponse.data.countries || !Array.isArray(apiResponse.data.countries)) {
      throw new Error('Invalid response format from Roanuz API');
    }
    
    const countriesData = apiResponse.data.countries;
    console.log(`Received ${countriesData.length} countries from Roanuz API`);
    
    let created = 0;
    let updated = 0;
    let errors = 0;
    
    for (const countryData of countriesData) {
      try {
        const { short_code, code, name, official_name, is_region } = countryData;
        
        if (!short_code || !code || !name) {
          console.warn('Skipping country with missing short_code, code or name:', countryData);
          errors++;
          continue;
        }
        
        if (is_region) {
          console.log(`Skipping region: ${name}`);
          continue;
        }
        
        const countryName = name.trim();
        const officialName = official_name && official_name.trim() ? official_name.trim() : null;
        const shortCode = short_code.toUpperCase();
        const countryCode = code.toUpperCase();
        
        let flagSvg = DEFAULT_FLAG_SVG;
        try {
          const flagResponse = await roanuzService.getCountryFlag(countryCode);
          if (flagResponse && typeof flagResponse === 'string' && flagResponse.includes('<svg')) {
            flagSvg = flagResponse;
          }
        } catch (flagError) {
          console.warn(`Could not fetch flag for ${countryCode}, using default:`, flagError.message);
        }
        
        const result = await Country.findOneAndUpdate(
          { code: countryCode },
          {
            short_code: shortCode,
            code: countryCode,
            name: countryName,
            official_name: officialName,
            flagSvg
          },
          { new: true, upsert: true }
        );
        
        if (result.isNew) {
          created++;
        } else {
          updated++;
        }
        
        console.log(`Processed country: ${shortCode} (${countryCode}) - ${countryName}${officialName ? ` (${officialName})` : ''}`);
      } catch (countryError) {
        console.error(`Error processing country ${countryData.short_code || countryData.code}:`, countryError.message);
        errors++;
      }
    }
    
    const result = {
      total: countriesData.length,
      created,
      updated,
      errors,
      timestamp: new Date()
    };
    
    console.log('Countries sync completed:', result);
    return result;
  } catch (error) {
    console.error('Error in syncCountriesFromRoanuzInternal:', error);
    throw error;
  }
};

/**
 * Update a country with its flag
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object} - Returns updated country
 */
exports.updateCountry = async (req, res) => {
  try {
    const { countryCode } = req.params;
    const { name } = req.body;
    
    if (!countryCode || countryCode.length < 2) {
      return res.status(400).json({
        message: 'Invalid country code',
      });
    }

    if (!name) {
      return res.status(400).json({
        message: 'Country name is required',
      });
    }

    const code = countryCode.toUpperCase();
    
    const apiResponse = await roanuzService.getCountryFlag(code);
    
    if (!apiResponse || typeof apiResponse !== 'string' || !apiResponse.includes('<svg')) {
      return res.status(404).json({
        message: 'Country flag not found',
      });
    }
    
    const flagSvg = apiResponse;
    
    const country = await Country.findOneAndUpdate(
      { code },
      { 
        code,
        name,
        flagSvg
      },
      { new: true, upsert: true }
    );
    
    const ttl = REDIS_TTL_LONG;
    await cacheService.set(`country_flag_${code}`, flagSvg, ttl);
    
    return res.status(200).json({
      message: 'Country updated successfully',
      country: {
        short_code: country.short_code,
        code: country.code,
        name: country.name,
        official_name: country.official_name,
        updatedAt: country.updatedAt,
      },
    });
  } catch (error) {
    console.error('Error updating country:', error);
    return res.status(500).json({
      message: 'Error updating country',
      error: process.env.NODE_ENV === 'production' ? {} : error.message,
    });
  }
}; 