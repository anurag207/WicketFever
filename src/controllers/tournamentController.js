const Tournament = require('../models/Tournament');
const roanuzService = require('../services/roanuzService');
const cacheService = require('../services/cacheService');
const flagService = require('../services/flagService');
const { REDIS_TTL_SHORT, REDIS_TTL_MEDIUM, REDIS_TTL_LONG, DEFAULT_FLAG_SVG, DEFAULT_PLAYER_IMAGE } = require('../config/constants');
const Match = require('../models/Match');

/**
 * Get featured tournaments
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */

exports.getFeaturedTournaments = async (req, res) => {
  try {
    console.log('Fetching featured tournaments');
    
    const cacheKey = 'featured_tournaments';
    
    // Try to get from Redis cache first
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log('Returning featured tournaments from Redis cache');
      return res.json(cachedRedisData);
    }
    
    // If not in Redis, try to get from MongoDB cache
    const cachedData = await Tournament.findOne({ 
      type: 'featured',
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    }).select('+raw_data');
    
    if (cachedData) {
      console.log('Returning featured tournaments from MongoDB cache');
      
      // Store in Redis for next time
      await cacheService.set(cacheKey, cachedData.raw_data.data || cachedData.raw_data, REDIS_TTL_SHORT);
      
      return res.json(cachedData.raw_data.data || cachedData.raw_data);
    }
    
    // If not in cache, get from API
    console.log('Fetching featured tournaments from Roanuz API');
    const apiData = await roanuzService.getFeaturedTournaments({
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT,
    });
    
    // Save to MongoDB cache (store the response for the featured tournaments collection)
    await Tournament.findOneAndUpdate(
      { type: 'featured' },
      { 
        type: 'featured',
        last_updated: new Date(),
        raw_data: apiData
      },
      { upsert: true, new: true }
    );
    // console.log("this is the apidata: "+ apiData.data.tournaments)
    // Save individual tournaments to the database
    if (apiData?.data?.tournaments) {
      const now = new Date();
      console.log("saving featured tournaments : " , apiData.data.tournaments.length);
      const updatePromises = apiData.data.tournaments.map(tournament => {
        // Determine tournament status based on dates
        let status = 'upcoming';
        const startDate = tournament.start_date ? new Date(tournament.start_date) : null;
        const endDate = tournament.end_date ? new Date(tournament.end_date) : null;
        
        if (startDate && endDate) {
          if (now > endDate) {
            status = 'completed';
          } else if (now >= startDate && now <= endDate) {
            status = 'ongoing';
          }
        }
        
        // Only save completed tournaments to the database
        if (status === 'completed') {
          return Tournament.findOneAndUpdate(
            { key: tournament.key },
            { 
              key: tournament.key,
              name: tournament.name,
              short_name: tournament.short_name,
              alternate_name: tournament.alternate_name,
              status: status,
              start_date: startDate,
              end_date: endDate,
              association: tournament.association,
              format: tournament.format,
              gender: tournament.gender,
              last_updated: new Date(),
              raw_data: tournament
            },
            { upsert: true, new: true }
          );
        }
        return Promise.resolve(); // Skip non-completed tournaments
      });
      
      await Promise.all(updatePromises);
    }
    
    // Save to Redis cache
    let ttl = REDIS_TTL_SHORT; // Default TTL
    if (apiData.cache?.expires) {
      const expiresMs = apiData.cache.expires * 1000; // Convert to milliseconds if needed
      const currentMs = Date.now();
      if (expiresMs > currentMs) {
        ttl = Math.floor((expiresMs - currentMs) / 1000); // Convert to seconds
      }
    }
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error('Error fetching featured tournaments  :', error.message);
    return res.status(500).json({ error: 'Failed to fetch featured tournaments' });
  }
};

/**
 * Get tournament details
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getTournamentDetails = async (req, res) => {
  try {
    const { tournamentKey } = req.params;
    if (!tournamentKey) {
      return res.status(400).json({ error: 'Tournament key is required' });
    }
    
    const cacheKey = `tournament:${tournamentKey}`;
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log(`Returning tournament details for ${tournamentKey} from Redis cache`);
      return res.json(cachedRedisData);
    }
    
    const cachedData = await Tournament.findOne({ 
      key: tournamentKey,
    }).select('+raw_data');
    
    if (cachedData) {
      console.log(`Returning tournament details for ${tournamentKey} from MongoDB cache`);
      
      const dataToCache = cachedData.raw_data?.data || cachedData.raw_data || cachedData;
      await cacheService.set(cacheKey, dataToCache, REDIS_TTL_SHORT);
      
      return res.json(dataToCache);
    }
    
    console.log(`Fetching tournament details for ${tournamentKey} from Roanuz API`);
    const apiData = await roanuzService.getTournamentDetails(tournamentKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    let status = 'upcoming';
    const now = new Date();
    const startDate = apiData.data?.start_date ? new Date(apiData.data.start_date) : null;
    const endDate = apiData.data?.end_date ? new Date(apiData.data.end_date) : null;
    
    if (startDate && endDate) {
      if (now > endDate) {
        status = 'completed';
      } else if (now >= startDate && now <= endDate) {
        status = 'ongoing';
      }
    }
    
    if (apiData?.data) {
      await Tournament.findOneAndUpdate(
        { key: tournamentKey },
        { 
          key: tournamentKey,
          name: apiData.data.name,
          short_name: apiData.data.short_name,
          alternate_name: apiData.data.alternate_name,
          status: status,
          start_date: startDate,
          end_date: endDate,
          association: apiData.data.association,
          format: apiData.data.format,
          gender: apiData.data.gender,
          last_updated: new Date(),
          raw_data: apiData
        },
        { upsert: true, new: true }
      );
    }
    
    let ttl = apiData.cache?.expires - Date.now();
    if (!Number.isFinite(ttl) || ttl <= 0) {
      ttl = REDIS_TTL_SHORT;
    }
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error(`Error fetching tournament details: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch tournament details' });
  }
};

/**
 * Get tournament points table
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getTournamentPointsTable = async (req, res) => {
  try {
    const { tournamentKey } = req.params;
    if (!tournamentKey) {
      return res.status(400).json({ error: 'Tournament key is required' });
    }
    
    const cacheKey = `tournament:${tournamentKey}:points`;
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log(`Returning points table for tournament ${tournamentKey} from Redis cache`);
      return res.json(cachedRedisData);
    }
    
    const cachedData = await Tournament.findOne({ 
      key: `${tournamentKey}_points`,
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    });
    
    if (cachedData) {
      console.log(`Returning points table for tournament ${tournamentKey} from MongoDB cache`);
      
      await cacheService.set(cacheKey, cachedData.raw_data.data || cachedData.raw_data, REDIS_TTL_SHORT);
      
      return res.json(cachedData.raw_data.data || cachedData.raw_data);
    }
    
    console.log(`Fetching points table for tournament ${tournamentKey} from Roanuz API`);
    
    const apiData = await roanuzService.getTournamentPointsTable(tournamentKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    await Tournament.findOneAndUpdate(
      { key: `${tournamentKey}_points` },
      { 
        key: `${tournamentKey}_points`,
        data: apiData,
        last_updated: new Date()
      },
      { upsert: true, new: true }
    );
    
    let ttl = REDIS_TTL_SHORT;
    if (apiData.cache) {
      if (apiData.cache.expires) {
        const expiresMs = apiData.cache.expires * 1000;
        const currentMs = Date.now();
        if (expiresMs > currentMs) {
          ttl = Math.floor((expiresMs - currentMs) / 1000);
        }
      } else if (apiData.cache.max_age) {
        ttl = apiData.cache.max_age;
      }
    }
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error(`Error fetching tournament points table: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch tournament points table' });
  }
};

/**
 * Get tournament fixtures
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getTournamentFixtures = async (req, res) => {
  try {
    const { tournamentKey } = req.params;
    if (!tournamentKey) {
      return res.status(400).json({ error: 'Tournament key is required' });
    }
    
    const cacheKey = `tournament:${tournamentKey}:fixtures`;
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log(`Returning fixtures for tournament ${tournamentKey} from Redis cache`);
      return res.json(cachedRedisData);
    }
    
    const cachedKey = `${tournamentKey}_fixtures`;
    const cachedData = await Tournament.findOne({ 
      key: cachedKey,
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    });
    
    if (cachedData) {
      console.log(`Returning fixtures for tournament ${tournamentKey} from MongoDB cache`);
      
      const dataToReturn = cachedData.raw_data.data || cachedData.raw_data;
      
      if (dataToReturn?.matches) {
        dataToReturn.matches = await addCountryFlagsToMatches(dataToReturn.matches);
      }
      
      await cacheService.set(cacheKey, dataToReturn, REDIS_TTL_SHORT);
      
      return res.json(dataToReturn);
    }
    
    console.log(`Fetching fixtures for tournament ${tournamentKey} from Roanuz API`);
    const apiData = await roanuzService.getTournamentFixtures(tournamentKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    if (apiData?.data?.matches) {
      apiData.data.matches = await addCountryFlagsToMatches(apiData.data.matches);
    }
    
    await Tournament.findOneAndUpdate(
      { key: cachedKey },
      { 
        key: cachedKey,
        type: 'fixtures',
        last_updated: new Date(),
        raw_data: apiData
      },
      { upsert: true, new: true }
    );
    
    let ttl = REDIS_TTL_SHORT;
    if (apiData.cache) {
      if (apiData.cache.expires) {
        const expiresMs = apiData.cache.expires * 1000;
        const currentMs = Date.now();
        if (expiresMs > currentMs) {
          ttl = Math.floor((expiresMs - currentMs) / 1000);
        }
      } else if (apiData.cache.max_age) {
        ttl = apiData.cache.max_age;
      }
    }
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error(`Error fetching tournament fixtures: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch tournament fixtures' });
  }
};

/**
 * Get tournament matches
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getTournamentMatches = async (req, res) => {
  try {
    const { tournamentKey } = req.params;
    if (!tournamentKey) {
      return res.status(400).json({ error: 'Tournament key is required' });
    }
    
    const cacheKey = `tournament:${tournamentKey}:matches`;
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log(`Returning matches for tournament ${tournamentKey} from Redis cache`);
      return res.json(cachedRedisData);
    }
    
    const cachedKey = `${tournamentKey}_matches`;
    const cachedData = await Tournament.findOne({ 
      key: cachedKey,
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    });
    
    if (cachedData) {
      console.log(`Returning matches for tournament ${tournamentKey} from MongoDB cache`);
      
      const dataToReturn = cachedData.raw_data.data || cachedData.raw_data;
      if (dataToReturn?.matches) {
        dataToReturn.matches = await addCountryFlagsToMatches(dataToReturn.matches);
      }
      await cacheService.set(cacheKey, dataToReturn, REDIS_TTL_SHORT);
      return res.json(dataToReturn);
    }
    
    console.log(`Fetching matches for tournament ${tournamentKey} from Roanuz API`);
    const apiData = await roanuzService.getTournamentMatches(tournamentKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    if (apiData?.data?.matches) {
      apiData.data.matches = await addCountryFlagsToMatches(apiData.data.matches);
    }
    
    await Tournament.findOneAndUpdate(
      { key: cachedKey },
      { 
        key: cachedKey,
        type: 'matches',
        last_updated: new Date(),
        raw_data: apiData
      },
      { upsert: true, new: true }
    );
    
    if (apiData?.data?.matches) {
      const updatePromises = apiData.data.matches.map(match => {
        if (match.status === 'completed') {
          return Match.findOneAndUpdate(
            { key: match.key },
            { 
              ...match,
              last_updated: new Date(),
              raw_data: match
            },
            { upsert: true, new: true }
          );
        }
        return Promise.resolve();
      });
      
      await Promise.all(updatePromises);
    }
    
    let ttl = REDIS_TTL_SHORT;
    if (apiData.cache) {
      if (apiData.cache.expires) {
        const expiresMs = apiData.cache.expires * 1000;
        const currentMs = Date.now();
        if (expiresMs > currentMs) {
          ttl = Math.floor((expiresMs - currentMs) / 1000);
        }
      } else if (apiData.cache.max_age) {
        ttl = apiData.cache.max_age;
      }
    }
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error(`Error fetching tournament matches: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch tournament matches' });
  }
};

/**
 * Get tournament featured matches
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getTournamentFeaturedMatches = async (req, res) => {
  try {
    const { tournamentKey } = req.params;
    if (!tournamentKey) {
      return res.status(400).json({ error: 'Tournament key is required' });
    }
    
    const cacheKey = `tournament:${tournamentKey}:featured_matches`;
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log(`Returning featured matches for tournament ${tournamentKey} from Redis cache`);
      return res.json(cachedRedisData);
    }
    
    const cachedKey = `${tournamentKey}_featured_matches`;
    const cachedData = await Tournament.findOne({ 
      key: cachedKey,
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    });
    
    if (cachedData) {
      console.log(`Returning featured matches for tournament ${tournamentKey} from MongoDB cache`);
      
      const dataToReturn = cachedData.raw_data.data || cachedData.raw_data;
      if (dataToReturn?.matches) {
        dataToReturn.matches = await addCountryFlagsToMatches(dataToReturn.matches);
      }
      await cacheService.set(cacheKey, dataToReturn, REDIS_TTL_SHORT);
      return res.json(dataToReturn);
    }
    
    console.log(`Fetching featured matches for tournament ${tournamentKey} from Roanuz API`);
    const apiData = await roanuzService.getTournamentFeaturedMatches(tournamentKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    if (apiData?.data?.matches) {
      apiData.data.matches = await addCountryFlagsToMatches(apiData.data.matches);
    }
    
    await Tournament.findOneAndUpdate(
      { key: cachedKey },
      { 
        key: cachedKey,
        type: 'featured_matches',
        last_updated: new Date(),
        raw_data: apiData
      },
      { upsert: true, new: true }
    );
    
    if (apiData?.data?.matches) {
      const updatePromises = apiData.data.matches.map(match => {
        if (match.status === 'completed') {
          return Match.findOneAndUpdate(
            { key: match.key },
            { 
              ...match,
              last_updated: new Date(),
              raw_data: match
            },
            { upsert: true, new: true }
          );
        }
        return Promise.resolve();
      });
      
      await Promise.all(updatePromises);
    }
    
    // Save to Redis cache
    const ttl = apiData.cache?.max_age || REDIS_TTL_SHORT;
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error(`Error fetching tournament featured matches: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch tournament featured matches' });
  }
};

/**
 * Add country flags to matches
 * @param {Array} matches - Array of match objects
 * @returns {Array} - Array of match objects with country flags
 */
async function addCountryFlagsToMatches(matches) {
  try {
    const enhancedMatches = JSON.parse(JSON.stringify(matches));
    
    await Promise.all(enhancedMatches.map(async (match) => {
      if (match.teams && match.teams.a) {
        const teamACountryCode = match.teams.a.country_code;
        if (teamACountryCode) {
          try {
            const flagResult = await flagService.getCountryFlagSvg(teamACountryCode);
            match.teams.a.flag = flagResult.flagSvg;
            console.log(`Added flag for team A country: ${teamACountryCode} (source: ${flagResult.source})`);
          } catch (error) {
            console.error(`Error setting flag for country ${teamACountryCode}:`, error.message);
            match.teams.a.flag = DEFAULT_FLAG_SVG;
          }
        } else {
          match.teams.a.flag = DEFAULT_FLAG_SVG;
        }
      }
      
      if (match.teams && match.teams.b) {
        const teamBCountryCode = match.teams.b.country_code;
        if (teamBCountryCode) {
          try {
            const flagResult = await flagService.getCountryFlagSvg(teamBCountryCode);
            match.teams.b.flag = flagResult.flagSvg;
            console.log(`Added flag for team B country: ${teamBCountryCode} (source: ${flagResult.source})`);
          } catch (error) {
            console.error(`Error setting flag for country ${teamBCountryCode}:`, error.message);
            match.teams.b.flag = DEFAULT_FLAG_SVG;
          }
        } else {
          match.teams.b.flag = DEFAULT_FLAG_SVG;
        }
      }
    }));
    
    return enhancedMatches;
  } catch (error) {
    console.error('Error adding country flags to matches:', error);
    return matches;
  }
}

/**
 * Get associations list
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getAssociations = async (req, res) => {
  try {
    const cacheKey = 'associations';
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log('Returning associations from Redis cache');
      return res.json(cachedRedisData);
    }
    
    const cachedData = await Tournament.findOne({ 
      type: 'associations',
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    });
    
    if (cachedData) {
      console.log('Returning associations from MongoDB cache');
      
      await cacheService.set(cacheKey, cachedData.raw_data.data || cachedData.raw_data, REDIS_TTL_MEDIUM);
      
      return res.json(cachedData.raw_data.data || cachedData.raw_data);
    }
    
    console.log('Fetching associations from Roanuz API');
    const apiData = await roanuzService.getAssociations({
      useCache: true,
      cacheTTL: REDIS_TTL_LONG
    });
    
    await Tournament.findOneAndUpdate(
      { type: 'associations' },
      { 
        type: 'associations',
        last_updated: new Date(),
        raw_data: apiData
      },
      { upsert: true, new: true }
    );
    
    const ttl = apiData.cache?.max_age || REDIS_TTL_LONG;
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error('Error fetching associations:', error.message);
    return res.status(500).json({ error: 'Failed to fetch associations' });
  }
};

/**
 * Get association tournaments
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
exports.getAssociationTournaments = async (req, res) => {
  try {
    const { associationKey } = req.params;
    if (!associationKey) {
      return res.status(400).json({ error: 'Association key is required' });
    }
    
    const cacheKey = `association:${associationKey}:tournaments`;
    
    const cachedRedisData = await cacheService.get(cacheKey);
    if (cachedRedisData) {
      console.log(`Returning tournaments for association ${associationKey} from Redis cache`);
      return res.json(cachedRedisData);
    }
    
    const cachedKey = `${associationKey}_tournaments`;
    const cachedData = await Tournament.findOne({ 
      key: cachedKey,
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    });
    
    if (cachedData) {
      console.log(`Returning tournaments for association ${associationKey} from MongoDB cache`);
      
      await cacheService.set(cacheKey, cachedData.raw_data.data || cachedData.raw_data, REDIS_TTL_SHORT);
      
      return res.json(cachedData.raw_data.data || cachedData.raw_data);
    }
    
    console.log(`Fetching tournaments for association ${associationKey} from Roanuz API`);
    const apiData = await roanuzService.getAssociationTournaments(associationKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_LONG // 1 hour
    });
    
    await Tournament.findOneAndUpdate(
      { key: cachedKey },
      { 
        key: cachedKey,
        type: 'association_tournaments',
        last_updated: new Date(),
        raw_data: apiData
      },
      { upsert: true, new: true }
    );
    
    const ttl = apiData.cache?.max_age || REDIS_TTL_SHORT;
    await cacheService.set(cacheKey, apiData.data, ttl);
    
    return res.json(apiData.data);
  } catch (error) {
    console.error(`Error fetching tournaments for association ${req.params.associationKey}:`, error.message);
    return res.status(500).json({ error: 'Failed to fetch association tournaments' });
  }
};

/**
 * Get all tournaments
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getAllTournaments = async (req, res) => {
  try {
    const { limit = 20, page = 1, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const query = {};
    if (status && ['upcoming', 'ongoing', 'completed'].includes(status)) {
      query.status = status;
    } else {
      query.status = 'completed';
    }
    
    const tournaments = await Tournament.find(query)
      .sort({ start_date: -1 })
      .skip(skip)
      .limit(parseInt(limit));
      
    const total = await Tournament.countDocuments(query);
    
    res.json({
      data: {
        tournaments,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching tournaments:', error);
    res.status(500).json({ message: 'Error fetching tournaments', error: error.message });
  }
};

/**
 * Get current tournaments
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getCurrentTournaments = async (req, res) => {
  try {
    const now = new Date();
    
    const tournaments = await Tournament.find({
      start_date: { $lte: now },
      end_date: { $gte: now },
    }).sort({ start_date: -1 });
    
    res.json({ data: { tournaments } });
  } catch (error) {
    console.error('Error fetching current tournaments:', error);
    res.status(500).json({ message: 'Error fetching current tournaments', error: error.message });
  }
};

/**
 * Get upcoming tournaments for a specific country
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getUpcomingTournamentsForCountry = async (req, res) => {
  try {
    const { countryCode } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!countryCode) {
      return res.status(400).json({ message: 'Country code is required' });
    }

    const upperCountryCode = countryCode.toUpperCase();
    const cacheKey = `upcoming_tournaments_country:${upperCountryCode}:${page}:${limit}`;
    
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning upcoming tournaments for ${upperCountryCode} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    const lastUpdatedTournament = await Tournament.findOne({ 
      status: 'upcoming',
      $or: [
        { 'raw_data.countries.code': upperCountryCode },
        { 'raw_data.countries.short_code': upperCountryCode }
      ]
    }).sort({ last_updated: -1 });
      
    const needsRefresh = !lastUpdatedTournament || 
      (Date.now() - lastUpdatedTournament.last_updated.getTime() > 30 * 60 * 1000);
      
    if (needsRefresh) {
      console.log(`Fetching fresh upcoming tournaments data for ${upperCountryCode} from Roanuz API`);
      const apiResponse = await roanuzService.getFeaturedTournaments({
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT
      });
      
      if (apiResponse?.data?.tournaments) {
        const now = new Date();
        const updatePromises = apiResponse.data.tournaments.map(tournament => {
          let status = 'upcoming';
          const startDate = tournament.start_date ? new Date(tournament.start_date * 1000) : null;
          const endDate = tournament.end_date ? new Date(tournament.end_date * 1000) : null;
          
          if (startDate && endDate) {
            if (now > endDate) {
              status = 'completed';
            } else if (now >= startDate && now <= endDate) {
              status = 'ongoing';
            }
          }
          
          return Tournament.findOneAndUpdate(
            { key: tournament.key },
            { 
              key: tournament.key,
              name: tournament.name,
              short_name: tournament.short_name,
              alternate_name: tournament.alternate_name,
              status: status,
              start_date: startDate,
              end_date: endDate,
              association: tournament.association,
              format: tournament.format,
              gender: tournament.gender,
              last_updated: new Date(),
              raw_data: tournament
            },
            { upsert: true, new: true }
          );
        });
        
        await Promise.all(updatePromises);
      }
    }

    const upcomingTournaments = await Tournament.find({ 
      status: 'upcoming',
      $or: [
        { 'raw_data.countries.code': upperCountryCode },
        { 'raw_data.countries.short_code': upperCountryCode }
      ]
    })
      .sort({ start_date: 1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const totalTournaments = await Tournament.countDocuments({ 
      status: 'upcoming',
      $or: [
        { 'raw_data.countries.code': upperCountryCode },
        { 'raw_data.countries.short_code': upperCountryCode }
      ]
    });
    
    const response = {
      data: {
        tournaments: upcomingTournaments,
        country_code: upperCountryCode,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil(totalTournaments / parseInt(limit)),
          total_items: totalTournaments,
          items_per_page: parseInt(limit)
        }
      }
    };
    
    await cacheService.set(cacheKey, response, REDIS_TTL_SHORT);
    
    return res.json(response);
  } catch (error) {
    console.error(`Error fetching upcoming tournaments for country ${req.params.countryCode}:`, error);
    
    try {
      const upperCountryCode = req.params.countryCode.toUpperCase();
      const staleTournaments = await Tournament.find({ 
        status: 'upcoming',
        $or: [
          { 'raw_data.countries.code': upperCountryCode },
          { 'raw_data.countries.short_code': upperCountryCode }
        ]
      })
        .sort({ start_date: 1 })
        .limit(parseInt(req.query.limit || 10));
      
      if (staleTournaments && staleTournaments.length > 0) {
        console.log(`Returning stale upcoming tournaments for ${upperCountryCode}`);
        
        return res.json({ 
          data: { 
            tournaments: staleTournaments,
            country_code: upperCountryCode,
            stale: true 
          }
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    return res.status(500).json({ 
      message: `Error fetching upcoming tournaments for country ${req.params.countryCode}`, 
      error: error.message 
    });
  }
};

/**
 * Get completed tournaments for a specific country
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getCompletedTournamentsForCountry = async (req, res) => {
  try {
    const { countryCode } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!countryCode) {
      return res.status(400).json({ message: 'Country code is required' });
    }

    const upperCountryCode = countryCode.toUpperCase();
    const cacheKey = `completed_tournaments_country:${upperCountryCode}:${page}:${limit}`;
    
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning completed tournaments for ${upperCountryCode} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    const lastUpdatedTournament = await Tournament.findOne({ 
      status: 'completed',
      $or: [
        { 'raw_data.countries.code': upperCountryCode },
        { 'raw_data.countries.short_code': upperCountryCode }
      ]
    }).sort({ last_updated: -1 });
      
    const needsRefresh = !lastUpdatedTournament || 
      (Date.now() - lastUpdatedTournament.last_updated.getTime() > 6 * 60 * 60 * 1000);
      
    let apiResponse;
    if (needsRefresh) {
      console.log(`Fetching fresh completed tournaments data for ${upperCountryCode} from Roanuz API`);
      apiResponse = await roanuzService.getFeaturedTournaments({
        useCache: true,
        cacheTTL: 3600 // 1 hour
      });
      
      if (apiResponse?.data?.tournaments) {
        const now = new Date();
        const updatePromises = apiResponse.data.tournaments.map(tournament => {
          let status = 'upcoming';
          const startDate = tournament.start_date ? new Date(tournament.start_date * 1000) : null;
          const endDate = tournament.end_date ? new Date(tournament.end_date * 1000) : null;
          
          if (startDate && endDate) {
            if (now > endDate) {
              status = 'completed';
            } else if (now >= startDate && now <= endDate) {
              status = 'ongoing';
            }
          }
          
          return Tournament.findOneAndUpdate(
            { key: tournament.key },
            { 
              key: tournament.key,
              name: tournament.name,
              short_name: tournament.short_name,
              alternate_name: tournament.alternate_name,
              status: status,
              start_date: startDate,
              end_date: endDate,
              association: tournament.association,
              format: tournament.format,
              gender: tournament.gender,
              last_updated: new Date(),
              raw_data: tournament
            },
            { upsert: true, new: true }
          );
        });
        
        await Promise.all(updatePromises);
      }
    }

    const completedTournaments = await Tournament.find({ 
      status: 'completed',
      $or: [
        { 'raw_data.countries.code': upperCountryCode },
        { 'raw_data.countries.short_code': upperCountryCode }
      ]
    })
      .sort({ end_date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Tournament.countDocuments({ 
      status: 'completed',
      $or: [
        { 'raw_data.countries.code': upperCountryCode },
        { 'raw_data.countries.short_code': upperCountryCode }
      ]
    });

    const response = {
      data: {
        tournaments: completedTournaments,
        country_code: upperCountryCode,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    };
    
    let ttl = REDIS_TTL_MEDIUM;
    if (needsRefresh && apiResponse && apiResponse.cache) {
      if (apiResponse.cache.expires) {
        const expiresMs = apiResponse.cache.expires * 1000;
        const currentMs = Date.now();
        if (expiresMs > currentMs) {
          ttl = Math.floor((expiresMs - currentMs) / 1000);
        }
      } else if (apiResponse.cache.max_age) {
        ttl = apiResponse.cache.max_age;
      }
    }
    await cacheService.set(cacheKey, response, ttl);

    res.json(response);
  } catch (error) {
    console.error(`Error fetching completed tournaments for country ${req.params.countryCode}:`, error);
    
    try {
      const upperCountryCode = req.params.countryCode.toUpperCase();
      const staleTournaments = await Tournament.find({ 
        status: 'completed',
        $or: [
          { 'raw_data.countries.code': upperCountryCode },
          { 'raw_data.countries.short_code': upperCountryCode }
        ]
      })
        .sort({ end_date: -1 })
        .limit(parseInt(req.query.limit || 10));
      
      if (staleTournaments && staleTournaments.length > 0) {
        console.log(`Returning stale completed tournaments for ${upperCountryCode}`);
        
        return res.json({ 
          data: { 
            tournaments: staleTournaments,
            country_code: upperCountryCode,
            stale: true 
          }
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: `Error fetching completed tournaments for country ${req.params.countryCode}`, 
      error: error.message 
    });
  }
};

/**
 * Get featured tournaments for a specific country
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getFeaturedTournamentsForCountry = async (req, res) => {
  try {
    const { countryCode } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!countryCode) {
      return res.status(400).json({ message: 'Country code is required' });
    }

    const upperCountryCode = countryCode.toUpperCase();
    const cacheKey = `featured_tournaments_country:${upperCountryCode}:${page}:${limit}`;
    
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning featured tournaments for ${upperCountryCode} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    console.log(`Fetching featured tournaments data for ${upperCountryCode} from Roanuz API`);
    const apiResponse = await roanuzService.getFeaturedTournaments({
      useCache: true,
      cacheTTL: REDIS_TTL_MEDIUM
    });
    
    let filteredTournaments = [];
    if (apiResponse?.data?.tournaments) {
      filteredTournaments = apiResponse.data.tournaments.filter(tournament => {
        if (tournament.countries && Array.isArray(tournament.countries)) {
          return tournament.countries.some(country => 
            country.code === upperCountryCode || country.short_code === upperCountryCode
          );
        }
        return false;
      });
    }

    const totalTournaments = filteredTournaments.length;
    const paginatedTournaments = filteredTournaments.slice(skip, skip + parseInt(limit));
    
    const response = {
      data: {
        tournaments: paginatedTournaments,
        country_code: upperCountryCode,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil(totalTournaments / parseInt(limit)),
          total_items: totalTournaments,
          items_per_page: parseInt(limit)
        }
      }
    };
    
    await cacheService.set(cacheKey, response, REDIS_TTL_SHORT);
    
    return res.json(response);
  } catch (error) {
    console.error(`Error fetching featured tournaments for country ${req.params.countryCode}:`, error);
    
    return res.status(500).json({ 
      message: `Error fetching featured tournaments for country ${req.params.countryCode}`, 
      error: error.message 
    });
  }
};

/**
 * Get team players for a specific tournament
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getTournamentTeamPlayers = async (req, res) => {
  try {
    const { tournamentKey, teamKey } = req.params;
    
    if (!tournamentKey) {
      return res.status(400).json({ message: 'Tournament key is required' });
    }
    
    if (!teamKey) {
      return res.status(400).json({ message: 'Team key is required' });
    }

    const lowerTeamKey = teamKey.toLowerCase();
    const cacheKey = `tournament:${tournamentKey}:team:${lowerTeamKey}`;
    
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning team ${lowerTeamKey} players for tournament ${tournamentKey} from Redis cache`);
      return res.json(cachedData);
    }

    const cachedKey = `${tournamentKey}_team_${lowerTeamKey}`;
    const cachedDbData = await Tournament.findOne({ 
      key: cachedKey,
      last_updated: { $gt: new Date(Date.now() - REDIS_TTL_SHORT * 1000) }
    }).select('+raw_data');
    
    if (cachedDbData) {
      console.log(`Returning team ${lowerTeamKey} players for tournament ${tournamentKey} from MongoDB cache`);
      
      let responseData = cachedDbData.raw_data.data || cachedDbData.raw_data;
      
      if (responseData.tournament_team && responseData.tournament_team.players) {
        Object.values(responseData.tournament_team.players).forEach(player => {
          player.image_url = DEFAULT_PLAYER_IMAGE;
        });
      }
      
      await cacheService.set(cacheKey, responseData, REDIS_TTL_SHORT);
      
      return res.json(responseData);
    }

    console.log(`Fetching team ${lowerTeamKey} players for tournament ${tournamentKey} from Roanuz API`);
    const apiResponse = await roanuzService.getTournamentTeamPlayers(tournamentKey, lowerTeamKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    if (apiResponse.data.tournament_team && apiResponse.data.tournament_team.players) {
      Object.values(apiResponse.data.tournament_team.players).forEach(player => {
        player.image_url = DEFAULT_PLAYER_IMAGE;
      });
    }
    
    await Tournament.findOneAndUpdate(
      { key: cachedKey },
      { 
        key: cachedKey,
        type: 'tournament_team',
        last_updated: new Date(),
        raw_data: apiResponse
      },
      { upsert: true, new: true }
    );
    
    let ttl = REDIS_TTL_SHORT;
    if (apiResponse.cache) {
      if (apiResponse.cache.expires) {
        const expiresMs = apiResponse.cache.expires * 1000;
        const currentMs = Date.now();
        if (expiresMs > currentMs) {
          ttl = Math.floor((expiresMs - currentMs) / 1000);
        }
      } else if (apiResponse.cache.max_age) {
        ttl = apiResponse.cache.max_age;
      }
    }
    await cacheService.set(cacheKey, apiResponse.data, ttl);
    
    return res.json(apiResponse.data);
  } catch (error) {
    console.error(`Error fetching team ${req.params.teamKey} players for tournament ${req.params.tournamentKey}:`, error);
    
    return res.status(500).json({ 
      message: `Error fetching team ${req.params.teamKey} players for tournament ${req.params.tournamentKey}`, 
      error: error.message 
    });
  }
}; 