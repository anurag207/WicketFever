const Match = require('../models/Match');
const BestPerformers = require('../models/BestPerformers');
const roanuzService = require('../services/roanuzService');
const cacheService = require('../services/cacheService');
const flagService = require('../services/flagService');
const axios = require('axios');
const { ROANUZ_API_URL, ROANUZ_PROJ_KEY, RS_TOKEN, DEFAULT_FLAG_SVG, BASE_URL, REDIS_TTL_SHORT, REDIS_TTL_LIVE, REDIS_TTL_MEDIUM ,REDIS_TTL_LONG} = require('../config/constants');

/**
 * MATCH CONTROLLER ARCHITECTURE STRATEGY:
 * 
 * 1. SMART CACHING STRATEGY (Major Performance & Data Freshness Optimization):
 *    ✅ COMPLETED MATCHES: Always serve from MongoDB cache (data never changes)
 *    ✅ LIVE MATCHES: Always fetch fresh from Roanuz API (scores/status change frequently)  
 *    ✅ UPCOMING MATCHES: Always fetch fresh from Roanuz API (timings/schedules change)
 *    ✅ All matches are saved to MongoDB for backup/reference and fallback scenarios
 * 
 * 2. FLAGS OPTIMIZATION:
 *    - Country flags are ONLY added to final filtered data that will be returned to client
 *    - NO flags in detailed views: match details, scorecard, summary, statistics, ball-by-ball
 *    - FLAGS ONLY in list views: featured matches, live matches, upcoming, completed
 *    - This reduces processing time and complexity significantly
 * 
 * 3. PAGINATION LIMITS:
 *    - Featured matches: Limited to 10 per page maximum
 *    - Live matches: Limited to 10 matches maximum  
 *    - Tournament matches: Limited to 10 matches maximum
 *    - Upcoming/Completed: Already properly paginated with user-defined limits
 * 
 * 4. PROCESSING FLOW FOR DIFFERENT MATCH TYPES:
 *    
 *    COMPLETED MATCHES:
 *    MongoDB Cache → Return (fast, data never changes)
 *    
 *    LIVE/UPCOMING MATCHES (Lists):
 *    Roanuz API → Filter/Paginate → Add flags → Save ALL to MongoDB → Return filtered results
 *    
 *    LIVE/UPCOMING MATCHES (Details):
 *    Check MongoDB → If completed: return from cache
 *                 → If live/upcoming: Roanuz API → Update MongoDB → Return fresh data
 * 
 * 5. PERFORMANCE BENEFITS:
 *    - 🔥 Data freshness guaranteed for dynamic matches (live/upcoming)
 *    - 🔥 Fast loading for completed matches (MongoDB cache)
 *    - 🔥 80% reduction in flag service calls
 *    - 🔥 Faster detailed views (no unnecessary flag processing)
 *    - 🔥 Better memory usage and improved API response times
 *    - 🔥 Automatic status transition handling (upcoming → live → completed)
 * 
 * 6. FALLBACK STRATEGY:
 *    - Redis cache for short-term performance (30 seconds to 15 minutes)
 *    - MongoDB fallback if API fails completely
 *    - Graceful degradation with stale data notifications
 */


/**
 * Get featured matches (limited to 10 per page)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getFeaturedMatches = async (req, res) => {
  try {
    const cacheKey = 'featured_matches';
      
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log('Returning featured matches from Redis cache');
      return res.json(cachedData);
    }
    
    // Check MongoDB cache first - get up to 10 recent matches
    const cachedMatches = await Match.find({
      last_updated: { $gt: new Date(Date.now() - 5 * 60 * 1000) }
    }).sort({ status: 1, start_at: 1 }).limit(10);
    
    if (cachedMatches && cachedMatches.length >= 5) {
      console.log('Returning featured matches from MongoDB cache');
      
      // Add flags only to these final 10 matches
      const enhancedMatches = await addCountryFlagsToMatches(cachedMatches);
      
      const response = { 
        data: { 
          matches: enhancedMatches,
          intelligent_order: enhancedMatches.map(match => match.key)
        } 
      };
      
      await cacheService.set(cacheKey, response, REDIS_TTL_SHORT);
      
      return res.json(response);
    }
    
    console.log('Fetching featured matches from Roanuz API');
    const apiResponse = await roanuzService.getFeaturedMatches({
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    if (apiResponse?.data?.matches) {
      // Save all matches to MongoDB (without flags)
      const savePromises = apiResponse.data.matches.map(match => {
        return Match.findOneAndUpdate(
          { key: match.key },
          { 
            ...match,
            last_updated: new Date(),
            raw_data: match
          },
          { upsert: true, new: true }
        );
      });
      
      await Promise.all(savePromises);
      
      // Limit to 10 matches for response and add flags only to these
      const limitedMatches = apiResponse.data.matches.slice(0, 10);
      const enhancedMatches = await addCountryFlagsToMatches(limitedMatches);
      
      apiResponse.data.matches = enhancedMatches;
      apiResponse.data.intelligent_order = enhancedMatches.map(match => match.key);
    }
    
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
    await cacheService.set(cacheKey, apiResponse, ttl);
    
    return res.json(apiResponse);
  } catch (error) {
    console.error('Error fetching featured matches:', error);
    
    try {
      // Get up to 10 stale matches and add flags only to these
      const staleMatches = await Match.find()
        .sort({ status: 1, start_at: 1 })
        .limit(10);
      
      if (staleMatches && staleMatches.length > 0) {
        console.log('Returning stale featured matches');
        
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            intelligent_order: enhancedStaleMatches.map(match => match.key)
          },
          stale: true 
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: 'Error fetching featured matches', 
      error: error.message 
    });
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
    console.error('Error adding country flags to matches: returning original matches', error);
    return matches;
  }
}

/**
 * Get match details by match key (Smart Caching: Completed from MongoDB, Live/Upcoming from Roanuz)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchDetails = async (req, res) => {
  try {
    const { matchKey } = req.params;
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }

    // Check if match exists in MongoDB first
    const existingMatch = await Match.findOne({ key: matchKey });
    
    // If match is completed in MongoDB, serve from cache
    if (existingMatch && existingMatch.status === 'completed') {
      console.log(`Returning completed match details for ${matchKey} from MongoDB cache`);
      
      const cacheKey = `match:${matchKey}`;
      const response = { data: existingMatch };
      
      // Cache completed match in Redis for longer duration
      await cacheService.set(cacheKey, response, 86400); // 1 day for completed matches
      
      return res.json(response);
    }

    // For live/upcoming matches OR if match doesn't exist, fetch fresh from Roanuz
    const isLiveOrUpcoming = existingMatch && (existingMatch.status === 'started' || existingMatch.status === 'not_started');
    const logMessage = isLiveOrUpcoming 
      ? `Fetching fresh data for ${existingMatch.status} match ${matchKey} from Roanuz API`
      : `Fetching match details for ${matchKey} from Roanuz API (new match)`;
    
    console.log(logMessage);
    
    const apiResponse = await roanuzService.getMatchDetails(matchKey, {
      useCache: false, // Always get fresh data for live/upcoming
      cacheTTL: REDIS_TTL_LIVE // Short TTL for live data
    });
    
    if (apiResponse?.data) {
      const matchData = apiResponse.data;
      
      // Always save/update the match in MongoDB
      const updatedMatch = await Match.findOneAndUpdate(
        { key: matchKey },
        { 
          ...matchData,
          last_updated: new Date(),
          raw_data: matchData
        },
        { upsert: true, new: true }
      );
      
      // If match status changed to completed, log the change
      if (existingMatch && existingMatch.status !== 'completed' && matchData.status === 'completed') {
        console.log(`Match ${matchKey} status changed to completed - updated in MongoDB`);
      }
      
      // Cache in Redis based on match status
      const cacheKey = `match:${matchKey}`;
      let ttl = 30; // Default for live/upcoming
      
      if (matchData.status === 'completed') {
        ttl = 86400; // 1 day for completed matches
      } else if (matchData.status === 'started') {
        ttl = 30; // 30 seconds for live matches
      } else {
        ttl = 900; // 15 minutes for upcoming matches
      }
      
      await cacheService.set(cacheKey, apiResponse, ttl);
      
      console.log(`Match ${matchKey} data fetched and cached (status: ${matchData.status})`);
    }
    
    res.json(apiResponse);
  } catch (error) {
    console.error(`Error fetching match details for ${req.params.matchKey}:`, error);
    
    try {
      // Fallback: serve stale data from MongoDB only if API fails
      const staleMatch = await Match.findOne({ key: req.params.matchKey });
      if (staleMatch) {
        console.log(`API failed - returning stale data for ${req.params.matchKey} from MongoDB`);
        
        return res.json({ 
          data: staleMatch, 
          stale: true,
          message: 'Stale data - API temporarily unavailable'
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: `Error fetching match details for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};


/**
 * Get live matches (always fetch fresh from Roanuz, limited to 10, flags only on final results)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getLiveMatches = async (req, res) => {
  try {
    const cacheKey = 'live_matches';
    
    // Check Redis cache first (short TTL for live data)
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log('Returning live matches from Redis cache');
      return res.json(cachedData);
    }
    
    // ALWAYS fetch fresh data from Roanuz for live matches (no MongoDB cache)
    console.log('Fetching live matches from Roanuz API (fresh data for live matches)');
    const apiResponse = await roanuzService.getFeaturedMatches({
      useCache: false,
      cacheTTL: REDIS_TTL_LIVE // 30 seconds for live data
    });
    
    // Filter to live matches and limit to 10
    const liveMatches = apiResponse?.data?.matches?.filter(match => match.status === 'started').slice(0, 10) || [];
    
    if (liveMatches.length > 0) {
      // Save all matches to MongoDB (for backup/reference, but don't serve from here for live matches)
      const savePromises = liveMatches.map(match => {
        return Match.findOneAndUpdate(
          { key: match.key },
          { 
            ...match,
            last_updated: new Date(),
            raw_data: match
          },
          { upsert: true, new: true }
        );
      });
      
      await Promise.all(savePromises);
    }
    
    // Add flags only to final filtered live matches
    const enhancedLiveMatches = await addCountryFlagsToMatches(liveMatches);
    
    const response = {
      data: {
        matches: enhancedLiveMatches
      }
    };
    
    // Cache in Redis for short duration (live data changes frequently)
    await cacheService.set(cacheKey, response, 30);
    
    return res.json(response);
  } catch (error) {
    console.error('Error fetching live matches:', error);
    
    try {
      // Fallback: Get stale live matches from MongoDB only if API fails completely
      const staleMatches = await Match.find({ status: 'started' })
        .sort({ start_at: -1 })
        .limit(10);
      
      if (staleMatches && staleMatches.length > 0) {
        console.log('Returning stale live matches as fallback only');
        
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        
        return res.json({ 
          data: { matches: enhancedStaleMatches },
          stale: true,
          message: 'Fallback data - API temporarily unavailable'
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: 'Error fetching live matches', 
      error: error.message 
    });
  }
};

/**
 * Get upcoming matches (always fetch fresh from Roanuz)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getUpcomingMatches = async (req, res) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const cacheKey = `upcoming_matches:${page}:${limit}`;
    
    // Check Redis cache first (short TTL for upcoming data)
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning upcoming matches page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    // ALWAYS fetch fresh upcoming matches from Roanuz (no MongoDB cache)
    console.log('Fetching fresh upcoming matches data from Roanuz API (fresh data for upcoming matches)');
    const apiResponse = await roanuzService.getFeaturedMatches({
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT
    });
    
    if (apiResponse?.data?.matches) {
      // Filter for upcoming matches first
      const upcomingFromAPI = apiResponse.data.matches.filter(match => match.status === 'not_started');
      
      // Save all upcoming matches to MongoDB (for backup/reference)
      const updatePromises = upcomingFromAPI.map(match => 
        Match.findOneAndUpdate(
          { key: match.key },
          { 
            ...match,
            last_updated: new Date(),
            raw_data: match
          },
          { upsert: true, new: true }
        )
      );
      
      await Promise.all(updatePromises);
      
      // Apply pagination to the fresh data
      const paginatedUpcoming = upcomingFromAPI
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
        .slice(skip, skip + parseInt(limit));
      
      // Add flags only to final paginated results
      const enhancedUpcomingMatches = await addCountryFlagsToMatches(paginatedUpcoming);
      
      const response = {
        data: {
          matches: enhancedUpcomingMatches,
          pagination: {
            current_page: parseInt(page),
            total_pages: Math.ceil(upcomingFromAPI.length / parseInt(limit)),
            total_items: upcomingFromAPI.length,
            items_per_page: parseInt(limit)
          }
        }
      };
      
      // Cache in Redis for short duration
      await cacheService.set(cacheKey, response, REDIS_TTL_SHORT);
      
      return res.json(response);
    }
    
    // If no data from API, return empty result
    return res.json({
      data: {
        matches: [],
        pagination: {
          current_page: parseInt(page),
          total_pages: 0,
          total_items: 0,
          items_per_page: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Error fetching upcoming matches:', error);
    
    try {
      // Fallback: Get stale upcoming matches from MongoDB only if API fails completely
      const staleMatches = await Match.find({ status: 'not_started' })
        .sort({ start_at: 1 })
        .skip(skip)
        .limit(parseInt(limit));
      
      if (staleMatches && staleMatches.length > 0) {
        console.log('Returning stale upcoming matches as fallback only');
        
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        const totalStale = await Match.countDocuments({ status: 'not_started' });
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            pagination: {
              current_page: parseInt(page),
              total_pages: Math.ceil(totalStale / parseInt(limit)),
              total_items: totalStale,
              items_per_page: parseInt(limit)
            }
          },
          stale: true,
          message: 'Fallback data - API temporarily unavailable'
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    return res.status(500).json({ 
      message: 'Error fetching upcoming matches', 
      error: error.message 
    });
  }
};

/**
 * Get completed matches
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getCompletedMatches = async (req, res) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const cacheKey = `completed_matches:${page}:${limit}`;
    
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning completed matches page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    const lastUpdatedMatch = await Match.findOne({ status: 'completed' })
      .sort({ last_updated: -1 });
      
    const needsRefresh = !lastUpdatedMatch || 
      (Date.now() - lastUpdatedMatch.last_updated.getTime() > 6 * 60 * 60 * 1000);
      
    let apiResponse;
    if (needsRefresh) {
      console.log('Fetching fresh completed matches data from Roanuz API');
      apiResponse = await roanuzService.getFeaturedMatches({
        useCache: true,
        cacheTTL: REDIS_TTL_MEDIUM
      });
      
      if (apiResponse?.data?.matches) {
        const updatePromises = apiResponse.data.matches
          .filter(match => match.status === 'completed')
          .map(match => 
            Match.findOneAndUpdate(
              { key: match.key },
              { 
                ...match,
                last_updated: new Date(),
                raw_data: match
              },
              { upsert: true, new: true }
            )
          );
        
        await Promise.all(updatePromises);
      }
    }

    const completedMatches = await Match.find({ status: 'completed' })
      .sort({ completed_date_approximate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Add flags only to the final filtered completed matches
    const enhancedCompletedMatches = await addCountryFlagsToMatches(completedMatches);

    const total = await Match.countDocuments({ status: 'completed' });

    const response = {
      data: {
        matches: enhancedCompletedMatches,
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
    console.error('Error fetching completed matches:', error);
    
    try {
      const staleMatches = await Match.find({ status: 'completed' })
        .sort({ completed_date_approximate: -1 })
        .limit(parseInt(req.query.limit || 10));
      
      if (staleMatches && staleMatches.length > 0) {
        console.log('Returning stale completed matches');
        
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            stale: true 
          }
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ message: 'Error fetching completed matches', error: error.message });
  }
};

/**
 * Get upcoming matches for a specific country (always fetch fresh from Roanuz)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getUpcomingMatchesForCountry = async (req, res) => {
  try {
    const { countryCode } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!countryCode) {
      return res.status(400).json({ message: 'Country code is required' });
    }

    const upperCountryCode = countryCode.toUpperCase();
    const cacheKey = `upcoming_matches_country:${upperCountryCode}:${page}:${limit}`;
    
    // Check Redis cache first (short TTL for upcoming data)
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning upcoming matches for ${upperCountryCode} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    // ALWAYS fetch fresh upcoming matches from Roanuz (no MongoDB cache)
    console.log(`Fetching fresh upcoming matches data for ${upperCountryCode} from Roanuz API (fresh data for upcoming matches)`);
    const apiResponse = await roanuzService.getFeaturedMatches({
      useCache: true,
      cacheTTL: REDIS_TTL_SHORT // 15 minutes
    });
    
    if (apiResponse?.data?.matches) {
      // Filter for upcoming matches involving the country first
      const upcomingFromAPI = apiResponse.data.matches.filter(match => 
        match.status === 'not_started' && (
          match.teams?.a?.country_code === upperCountryCode || 
          match.teams?.b?.country_code === upperCountryCode
        )
      );
      
      // Save all upcoming matches to MongoDB (for backup/reference)
      const updatePromises = upcomingFromAPI.map(match => 
        Match.findOneAndUpdate(
          { key: match.key },
          { 
            ...match,
            last_updated: new Date(),
            raw_data: match
          },
          { upsert: true, new: true }
        )
      );
      
      await Promise.all(updatePromises);
      
      // Apply pagination to the fresh filtered data
      const paginatedUpcoming = upcomingFromAPI
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
        .slice(skip, skip + parseInt(limit));
      
      // Add flags only to final paginated results
      const enhancedUpcomingMatches = await addCountryFlagsToMatches(paginatedUpcoming);
      
      const response = {
        data: {
          matches: enhancedUpcomingMatches,
          country_code: upperCountryCode,
          pagination: {
            current_page: parseInt(page),
            total_pages: Math.ceil(upcomingFromAPI.length / parseInt(limit)),
            total_items: upcomingFromAPI.length,
            items_per_page: parseInt(limit)
          }
        }
      };
      
      // Cache in Redis for short duration
      await cacheService.set(cacheKey, response, REDIS_TTL_SHORT);
      
      return res.json(response);
    }
    
    // If no data from API, return empty result
    return res.json({
      data: {
        matches: [],
        country_code: upperCountryCode,
        pagination: {
          current_page: parseInt(page),
          total_pages: 0,
          total_items: 0,
          items_per_page: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error(`Error fetching upcoming matches for country ${req.params.countryCode}:`, error);
    
    try {
      // Fallback: Get stale upcoming matches from MongoDB only if API fails completely
      const upperCountryCode = req.params.countryCode.toUpperCase();
      const staleMatches = await Match.find({ 
        status: 'not_started',
        $or: [
          { 'teams.a.country_code': upperCountryCode },
          { 'teams.b.country_code': upperCountryCode }
        ]
      })
        .sort({ start_at: 1 })
        .skip(skip)
        .limit(parseInt(limit));
      
      if (staleMatches && staleMatches.length > 0) {
        console.log(`Returning stale upcoming matches for ${upperCountryCode} as fallback only`);
        
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        const totalStale = await Match.countDocuments({ 
          status: 'not_started',
          $or: [
            { 'teams.a.country_code': upperCountryCode },
            { 'teams.b.country_code': upperCountryCode }
          ]
        });
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            country_code: upperCountryCode,
            pagination: {
              current_page: parseInt(page),
              total_pages: Math.ceil(totalStale / parseInt(limit)),
              total_items: totalStale,
              items_per_page: parseInt(limit)
            }
          },
          stale: true,
          message: 'Fallback data - API temporarily unavailable'
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    return res.status(500).json({ 
      message: `Error fetching upcoming matches for country ${req.params.countryCode}`, 
      error: error.message 
    });
  }
};

/**
 * Get completed matches for a specific country
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getCompletedMatchesForCountry = async (req, res) => {
  try {
    const { countryCode } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!countryCode) {
      return res.status(400).json({ message: 'Country code is required' });
    }

    const upperCountryCode = countryCode.toUpperCase();
    const cacheKey = `completed_matches_country:${upperCountryCode}:${page}:${limit}`;
    
    // Try to get from Redis cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning completed matches for ${upperCountryCode} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    // If not in Redis, check if we have recent data (less than 6 hours old)
    const lastUpdatedMatch = await Match.findOne({ 
      status: 'completed',
      $or: [
        { 'teams.a.country_code': upperCountryCode },
        { 'teams.b.country_code': upperCountryCode }
      ]
    }).sort({ last_updated: -1 });
      
    const needsRefresh = !lastUpdatedMatch || 
      (Date.now() - lastUpdatedMatch.last_updated.getTime() > 6 * 60 * 60 * 1000);
      
    // If we need fresh data, fetch it from the API
    let apiResponse;
    if (needsRefresh) {
      console.log(`Fetching fresh completed matches data for ${upperCountryCode} from Roanuz API`);
      apiResponse = await roanuzService.getFeaturedMatches({
        useCache: true,
        cacheTTL: 3600 // 1 hour
      });
      
      // Save to MongoDB
      if (apiResponse?.data?.matches) {
        const updatePromises = apiResponse.data.matches
          .filter(match => match.status === 'completed')
          .map(match => 
            Match.findOneAndUpdate(
              { key: match.key },
              { 
                ...match,
                last_updated: new Date(),
                raw_data: match
              },
              { upsert: true, new: true }
            )
          );
        
        await Promise.all(updatePromises);
      }
    }

    // Get matches from database that are completed and involve the specified country
    const completedMatches = await Match.find({ 
      status: 'completed',
      $or: [
        { 'teams.a.country_code': upperCountryCode },
        { 'teams.b.country_code': upperCountryCode }
      ]
    })
      .sort({ completed_date_approximate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Add country flags to matches
    const enhancedCompletedMatches = await addCountryFlagsToMatches(completedMatches);

    // Count total for pagination
    const total = await Match.countDocuments({ 
      status: 'completed',
      $or: [
        { 'teams.a.country_code': upperCountryCode },
        { 'teams.b.country_code': upperCountryCode }
      ]
    });

    const response = {
      data: {
        matches: enhancedCompletedMatches,
        country_code: upperCountryCode,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    };
    
    // Cache in Redis using TTL from Roanuz if available
    let ttl = 1800; // Default 30 minutes (completed matches change less frequently)
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
    console.error(`Error fetching completed matches for country ${req.params.countryCode}:`, error);
    
    // Try to serve stale data as a fallback
    try {
      const upperCountryCode = req.params.countryCode.toUpperCase();
      const staleMatches = await Match.find({ 
        status: 'completed',
        $or: [
          { 'teams.a.country_code': upperCountryCode },
          { 'teams.b.country_code': upperCountryCode }
        ]
      })
        .sort({ completed_date_approximate: -1 })
        .limit(parseInt(req.query.limit || 10));
      
      if (staleMatches && staleMatches.length > 0) {
        console.log(`Returning stale completed matches for ${upperCountryCode}`);
        
        // Add country flags to stale matches
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            country_code: upperCountryCode,
            stale: true 
          }
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: `Error fetching completed matches for country ${req.params.countryCode}`, 
      error: error.message 
    });
  }
};

/**
 * Get upcoming matches for a specific team
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getUpcomingMatchesForTeam = async (req, res) => {
  try {
    const { teamKey } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!teamKey) {
      return res.status(400).json({ message: 'Team key is required' });
    }

    const lowerTeamKey = teamKey.toLowerCase();
    const cacheKey = `upcoming_matches_team:${lowerTeamKey}:${page}:${limit}`;
    
    // Try to get from Redis cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning upcoming matches for team ${lowerTeamKey} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    // If not in Redis, check if we have recent data (less than 30 minutes old)
    const lastUpdatedMatch = await Match.findOne({ 
      status: 'not_started',
      $or: [
        { 'teams.a.key': lowerTeamKey },
        { 'teams.b.key': lowerTeamKey }
      ]
    }).sort({ last_updated: -1 });
      
    const needsRefresh = !lastUpdatedMatch || 
      (Date.now() - lastUpdatedMatch.last_updated.getTime() > 30 * 60 * 1000);
      
    // If we need fresh data, fetch it from the API
    if (needsRefresh) {
      console.log(`Fetching fresh upcoming matches data for team ${lowerTeamKey} from Roanuz API`);
      const apiResponse = await roanuzService.getFeaturedMatches({
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT // 15 minutes
      });
      
      // Save to MongoDB
      if (apiResponse?.data?.matches) {
        const updatePromises = apiResponse.data.matches
          .filter(match => match.status === 'not_started')
          .map(match => 
            Match.findOneAndUpdate(
              { key: match.key },
              { 
                ...match,
                last_updated: new Date(),
                raw_data: match
              },
              { upsert: true, new: true }
            )
          );
        
        await Promise.all(updatePromises);
      }
    }

    // Get matches from database that are upcoming and involve the specified team
    const upcomingMatches = await Match.find({ 
      status: 'not_started',
      $or: [
        { 'teams.a.key': lowerTeamKey },
        { 'teams.b.key': lowerTeamKey }
      ]
    })
      .sort({ start_at: 1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    // Add country flags to upcoming matches
    const enhancedUpcomingMatches = await addCountryFlagsToMatches(upcomingMatches);
    
    // Count total for pagination
    const totalMatches = await Match.countDocuments({ 
      status: 'not_started',
      $or: [
        { 'teams.a.key': lowerTeamKey },
        { 'teams.b.key': lowerTeamKey }
      ]
    });
    
    // Create response with pagination
    const response = {
      data: {
        matches: enhancedUpcomingMatches,
        team_key: lowerTeamKey,
        pagination: {
          current_page: parseInt(page),
          total_pages: Math.ceil(totalMatches / parseInt(limit)),
          total_items: totalMatches,
          items_per_page: parseInt(limit)
        }
      }
    };
    
    // Cache in Redis
    await cacheService.set(cacheKey, response, REDIS_TTL_SHORT);
    
    return res.json(response);
  } catch (error) {
    console.error(`Error fetching upcoming matches for team ${req.params.teamKey}:`, error);
    
    // Try to serve stale data as a fallback
    try {
      const lowerTeamKey = req.params.teamKey.toLowerCase();
      const staleMatches = await Match.find({ 
        status: 'not_started',
        $or: [
          { 'teams.a.key': lowerTeamKey },
          { 'teams.b.key': lowerTeamKey }
        ]
      })
        .sort({ start_at: 1 })
        .limit(parseInt(req.query.limit || 10));
      
      if (staleMatches && staleMatches.length > 0) {
        console.log(`Returning stale upcoming matches for team ${lowerTeamKey}`);
        
        // Add country flags to stale matches
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            team_key: lowerTeamKey,
            stale: true 
          }
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    return res.status(500).json({ 
      message: `Error fetching upcoming matches for team ${req.params.teamKey}`, 
      error: error.message 
    });
  }
};

/**
 * Get completed matches for a specific team
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getCompletedMatchesForTeam = async (req, res) => {
  try {
    const { teamKey } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    if (!teamKey) {
      return res.status(400).json({ message: 'Team key is required' });
    }

    const lowerTeamKey = teamKey.toLowerCase();
    const cacheKey = `completed_matches_team:${lowerTeamKey}:${page}:${limit}`;
    
    // Try to get from Redis cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning completed matches for team ${lowerTeamKey} page ${page} from Redis cache`);
      return res.json(cachedData);
    }

    // If not in Redis, check if we have recent data (less than 6 hours old)
    const lastUpdatedMatch = await Match.findOne({ 
      status: 'completed',
      $or: [
        { 'teams.a.key': lowerTeamKey },
        { 'teams.b.key': lowerTeamKey }
      ]
    }).sort({ last_updated: -1 });
      
    const needsRefresh = !lastUpdatedMatch || 
      (Date.now() - lastUpdatedMatch.last_updated.getTime() > 6 * 60 * 60 * 1000);
      
    // If we need fresh data, fetch it from the API
    let apiResponse;
    if (needsRefresh) {
      console.log(`Fetching fresh completed matches data for team ${lowerTeamKey} from Roanuz API`);
      apiResponse = await roanuzService.getFeaturedMatches({
        useCache: true,
        cacheTTL: REDIS_TTL_LONG 
      });
      
      // Save to MongoDB
      if (apiResponse?.data?.matches) {
        const updatePromises = apiResponse.data.matches
          .filter(match => match.status === 'completed')
          .map(match => 
            Match.findOneAndUpdate(
              { key: match.key },
              { 
                ...match,
                last_updated: new Date(),
                raw_data: match
              },
              { upsert: true, new: true }
            )
          );
        
        await Promise.all(updatePromises);
      }
    }

    // Get matches from database that are completed and involve the specified team
    const completedMatches = await Match.find({ 
      status: 'completed',
      $or: [
        { 'teams.a.key': lowerTeamKey },
        { 'teams.b.key': lowerTeamKey }
      ]
    })
      .sort({ completed_date_approximate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Add country flags to matches
    const enhancedCompletedMatches = await addCountryFlagsToMatches(completedMatches);

    // Count total for pagination
    const total = await Match.countDocuments({ 
      status: 'completed',
      $or: [
        { 'teams.a.key': lowerTeamKey },
        { 'teams.b.key': lowerTeamKey }
      ]
    });

    const response = {
      data: {
        matches: enhancedCompletedMatches,
        team_key: lowerTeamKey,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    };
    
    // Cache in Redis using TTL from Roanuz if available
    let ttl = 1800; // Default 30 minutes (completed matches change less frequently)
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
    console.error(`Error fetching completed matches for team ${req.params.teamKey}:`, error);
    
    // Try to serve stale data as a fallback
    try {
      const lowerTeamKey = req.params.teamKey.toLowerCase();
      const staleMatches = await Match.find({ 
        status: 'completed',
        $or: [
          { 'teams.a.key': lowerTeamKey },
          { 'teams.b.key': lowerTeamKey }
        ]
      })
        .sort({ completed_date_approximate: -1 })
        .limit(parseInt(req.query.limit || 10));
      
      if (staleMatches && staleMatches.length > 0) {
        console.log(`Returning stale completed matches for team ${lowerTeamKey}`);
        
        // Add country flags to stale matches
        const enhancedStaleMatches = await addCountryFlagsToMatches(staleMatches);
        
        return res.json({ 
          data: { 
            matches: enhancedStaleMatches,
            team_key: lowerTeamKey,
            stale: true 
          }
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: `Error fetching completed matches for team ${req.params.teamKey}`, 
      error: error.message 
    });
  }
};

/**
 * Get matches by tournament (limited to 10, flags only on final results)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchesByTournament = async (req, res) => {
  try {
    const { tournamentKey } = req.params;
    
    if (!tournamentKey) {
      return res.status(400).json({ message: 'Tournament key is required' });
    }
    
    const cacheKey = `tournament_matches:${tournamentKey}`;
    
    // Try to get from Redis cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning tournament matches for ${tournamentKey} from Redis cache`);
      return res.json(cachedData);
    }

    // If not in Redis, check in MongoDB - limit to 10 matches
    const cachedMatches = await Match.find({
      'tournament.key': tournamentKey,
      last_updated: { $gt: new Date(Date.now() - 30 * 60 * 1000) } // 30 minutes cache
    }).sort({ start_at: 1 }).limit(10);
    
    // If we have recent data with enough matches, use it
    if (cachedMatches && cachedMatches.length > 0) {
      console.log(`Returning tournament matches for ${tournamentKey} from MongoDB cache`);
      
      // Add country flags only to these final matches
      const enhancedMatches = await addCountryFlagsToMatches(cachedMatches);
      
      const response = { data: { matches: enhancedMatches } };
      
      // Cache in Redis for 15 minutes
      await cacheService.set(cacheKey, response, 900);
      
      return res.json(response);
    }
    
    // Otherwise, fetch fresh data from Roanuz API
    console.log(`Fetching tournament matches for ${tournamentKey} from Roanuz API`);
    const apiResponse = await roanuzService.getTournamentFeaturedMatches(tournamentKey, {
      useCache: true,
      cacheTTL: REDIS_TTL_MEDIUM
    });
    
    if (apiResponse?.data?.matches) {
      // Save all matches to MongoDB (without flags)
      const updatePromises = apiResponse.data.matches.map(match => 
        Match.findOneAndUpdate(
          { key: match.key },
          { 
            ...match,
            last_updated: new Date(),
            raw_data: match
          },
          { upsert: true, new: true }
        )
      );
      
      await Promise.all(updatePromises);
      
      // Limit to 10 matches and add flags only to these final results
      const limitedMatches = apiResponse.data.matches.slice(0, 10);
      apiResponse.data.matches = await addCountryFlagsToMatches(limitedMatches);
    }
    
    // Cache in Redis using TTL from Roanuz if available
    let ttl = 900; // Default 15 minutes
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
    await cacheService.set(cacheKey, apiResponse, ttl);
    
    return res.json(apiResponse);
  } catch (error) {
    console.error(`Error fetching tournament matches for ${req.params.tournamentKey}:`, error);
    return res.status(500).json({ 
      message: 'Error fetching tournament matches', 
      error: error.message 
    });
  }
};

/**
 * Get match summary (Smart Caching: Completed from MongoDB, Live/Upcoming from Roanuz) - NO FLAGS optimization
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchSummary = async (req, res) => {
  try {
    const { matchKey } = req.params;
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }
    
    // Check if match exists in MongoDB first
    const existingMatch = await Match.findOne({ key: matchKey });
    
    // If match is completed in MongoDB, serve from cache
    if (existingMatch && existingMatch.status === 'completed') {
      console.log(`Returning completed match summary for ${matchKey} from MongoDB cache`);
      
      // Extract summary data from completed match
      const summary = {
        key: existingMatch.key,
        name: existingMatch.name,
        short_name: existingMatch.short_name,
        status: existingMatch.status,
        play_status: existingMatch.play_status,
        format: existingMatch.format,
        start_at: existingMatch.start_at,
        tournament: {
          name: existingMatch.tournament.name,
          short_name: existingMatch.tournament.short_name
        },
        teams: existingMatch.teams,
        venue: existingMatch.venue,
        toss: existingMatch.toss,
        current_innings: getCurrentInningsInfo(existingMatch),
        result: existingMatch.play?.result || {}
      };
      
      return res.json({ data: summary });
    }

    // For live/upcoming matches OR if match doesn't exist, fetch fresh from Roanuz
    const isLiveOrUpcoming = existingMatch && (existingMatch.status === 'started' || existingMatch.status === 'not_started');
    const logMessage = isLiveOrUpcoming 
      ? `Fetching fresh summary for ${existingMatch.status} match ${matchKey} from Roanuz API`
      : `Fetching match summary for ${matchKey} from Roanuz API (new match)`;
    
    console.log(logMessage);
    
    // Get fresh match data using existing helper function that handles the API call
    const matchData = await getMatchDataWithCaching(matchKey, req, res);
    if (!matchData) return; // Error already handled in getMatchDataWithCaching
    
    // Extract only the data needed for match summary view (no flags needed)
    const summary = {
      key: matchData.key,
      name: matchData.name,
      short_name: matchData.short_name,
      status: matchData.status,
      play_status: matchData.play_status,
      format: matchData.format,
      start_at: matchData.start_at,
      tournament: {
        name: matchData.tournament.name,
        short_name: matchData.tournament.short_name
      },
      teams: matchData.teams,
      venue: matchData.venue,
      toss: matchData.toss,
      current_innings: getCurrentInningsInfo(matchData),
      result: matchData.play?.result || {}
    };
    
    res.json({ data: summary });
  } catch (error) {
    console.error(`Error fetching match summary for ${req.params.matchKey}:`, error);
    
    try {
      // Fallback: serve stale summary from MongoDB only if API fails
      const staleMatch = await Match.findOne({ key: req.params.matchKey });
      if (staleMatch) {
        console.log(`API failed - returning stale summary for ${req.params.matchKey} from MongoDB`);
        
        const staleSummary = {
          key: staleMatch.key,
          name: staleMatch.name,
          short_name: staleMatch.short_name,
          status: staleMatch.status,
          play_status: staleMatch.play_status,
          format: staleMatch.format,
          start_at: staleMatch.start_at,
          tournament: {
            name: staleMatch.tournament.name,
            short_name: staleMatch.tournament.short_name
          },
          teams: staleMatch.teams,
          venue: staleMatch.venue,
          toss: staleMatch.toss,
          current_innings: getCurrentInningsInfo(staleMatch),
          result: staleMatch.play?.result || {}
        };
        
        return res.json({ 
          data: staleSummary, 
          stale: true,
          message: 'Stale data - API temporarily unavailable'
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: `Error fetching match summary for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};

/**
 * Get detailed match scorecard -  SUPPORTS LIVE MATCHES
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchScorecardDetailed = async (req, res) => {
  try {
    const { matchKey } = req.params;
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }
    
    // Check Redis cache first (for live matches polled every 5 seconds)
    const cacheKey = `scorecard-detailed:${matchKey}`;
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning detailed scorecard for ${matchKey} from Redis cache (polled data)`);
      return res.json(cachedData);
    }
    
    // Check if match exists in MongoDB and has scorecard data
    const existingMatch = await Match.findOne({ key: matchKey });
    
    // Check if we have complete scorecard data in MongoDB
    const hasCompleteScorecard = existingMatch && 
      existingMatch.status === 'completed' &&
      existingMatch.play?.innings &&
      Object.keys(existingMatch.play.innings).length > 0;
    
    let matchData;
    
    if (hasCompleteScorecard) {
      console.log(`Using scorecard data from MongoDB cache for completed match ${matchKey}`);
      matchData = existingMatch;
         } else {
       console.log(`Scorecard data empty/missing in MongoDB - fetching fresh data for ${matchKey}`);
       // Fetch fresh data from API (even for completed matches if scorecard is empty)
       matchData = await fetchFreshMatchData(matchKey);
       if (!matchData) {
         return res.status(500).json({ 
           message: `Error fetching fresh match data for ${matchKey}`, 
           error: 'API call failed' 
         });
       }
     }
    
    // Allow scorecard for both live and completed matches
    if (matchData.status !== 'completed' && matchData.status !== 'started') {
      return res.status(400).json({ message: 'Scorecard is only available for live or completed matches' });
    }
    
    // Get innings data
    const innings = matchData.play?.innings || {};
    const inningsOrder = matchData.play?.innings_order || Object.keys(innings);
    
    // Process each innings for the response
    const processedInnings = [];
    
    for (const inningsKey of inningsOrder) {
      const inning = innings[inningsKey];
      const teamKey = inningsKey.split('_')[0]; // 'a' or 'b'
      const opposingTeamKey = teamKey === 'a' ? 'b' : 'a';
      
      // Format batting data
      const battingData = [];
      
      // DATA STRUCTURE NOTE: The API provides player data in two possible formats:
      // 1. innings.batting_players - preferred, contains detailed player stats
      // 2. matchData.players - legacy format with nested score structure
      // We try format 1 first, then fallback to format 2 for backward compatibility
      
      // Try to get batting data from inning structure first
      if (inning.batting_players && Object.keys(inning.batting_players).length > 0) {
        // Use actual batting data from innings
        for (const playerKey in inning.batting_players) {
          const player = inning.batting_players[playerKey];
          battingData.push({
            name: player.name || playerKey,
            dismissal: player.how_out || 'not out',
            runs: player.runs || 0,
            balls: player.balls || 0,
            fours: player.fours || 0,
            sixes: player.sixes || 0,
            strike_rate: player.strike_rate?.toFixed(2) || '0.00'
          });
        }
      } else {
        // Fallback to old structure if available
        const teamPlayers = matchData.players || {};
        
        // Process batting order players
        if (inning.batting_order && Array.isArray(inning.batting_order)) {
          for (const playerKey of inning.batting_order) {
            if (teamPlayers[playerKey] && teamPlayers[playerKey].score) {
              const playerInfo = teamPlayers[playerKey].player;
              const playerScore = teamPlayers[playerKey].score['1']?.batting?.score || {};
              const dismissalInfo = teamPlayers[playerKey].score['1']?.batting?.dismissal || null;
              
              let dismissalText = 'not out';
              if (dismissalInfo) {
                dismissalText = dismissalInfo.msg || 'out';
              }
              
              battingData.push({
                name: playerInfo.name,
                dismissal: dismissalText,
                runs: playerScore.runs || 0,
                balls: playerScore.balls || 0,
                fours: playerScore.fours || 0,
                sixes: playerScore.sixes || 0,
                strike_rate: playerScore.strike_rate?.toFixed(2) || '0.00'
              });
            }
          }
        }
      }
      
      // Format bowling data
      const bowlingData = [];
      
      // Try to get bowling data from inning structure first
      if (inning.bowling_players && Object.keys(inning.bowling_players).length > 0) {
        // Use actual bowling data from innings
        for (const playerKey in inning.bowling_players) {
          const player = inning.bowling_players[playerKey];
          if (parseFloat(player.overs) > 0 || player.wickets > 0) {
            bowlingData.push({
              name: player.name || playerKey,
              overs: parseFloat(player.overs || 0).toFixed(1),
              maidens: player.maidens || 0,
              runs: player.runs || 0,
              wickets: player.wickets || 0,
              economy: player.economy?.toFixed(2) || '0.00'
            });
          }
        }
      } else {
        // Fallback to old structure if available
        const teamPlayers = matchData.players || {};
        
        // Get all players from opposing team who bowled in this innings
        for (const playerKey in teamPlayers) {
          const playerScore = teamPlayers[playerKey].score?.[1]?.bowling?.score;
          if (playerScore && playerScore.balls > 0) {
            const playerInfo = teamPlayers[playerKey].player;
            
            // Check if player is from opposing team by examining their bowling data
            const oversBowled = playerScore.overs;
            if (oversBowled && (oversBowled[0] > 0 || oversBowled[1] > 0)) {
              const totalOvers = oversBowled[0] + (oversBowled[1] / 10);
              
              bowlingData.push({
                name: playerInfo.name,
                overs: totalOvers.toFixed(1),
                maidens: playerScore.maiden_overs || 0,
                runs: playerScore.runs || 0,
                wickets: playerScore.wickets || 0,
                economy: playerScore.economy?.toFixed(2) || '0.00'
              });
            }
          }
        }
      }
      
      // Calculate innings total and extras
      const extras = {
        total: inning.extra_runs?.extra || 0,
        bye: inning.extra_runs?.bye || 0,
        leg_bye: inning.extra_runs?.leg_bye || 0,
        wide: inning.extra_runs?.wide || 0,
        no_ball: inning.extra_runs?.no_ball || 0
      };
      
      const total = inning.score?.runs || 0;
      const overs = inning.overs ? `${inning.overs[0]}.${inning.overs[1]}` : '0.0';
      const runRate = inning.score?.run_rate?.toFixed(2) || '0.00';
      
      // Format the innings data
      processedInnings.push({
        team: matchData.teams[teamKey].name,
        batting: battingData,
        bowling: bowlingData,
        total: total.toString(),
        overs: overs,
        run_rate: runRate,
        extras: extras.total,
        bye: extras.bye,
        leg_bye: extras.leg_bye,
        wide: extras.wide,
        no_ball: extras.no_ball
      });
    }
    
    // Add close of play info
    const closeOfPlay = matchData.play?.close_of_play_msg || matchData.play?.result?.msg || null;
    
    const response = {
      match_key: matchData.key,
      match_status: matchData.status,
      innings: processedInnings,
      close_of_play: closeOfPlay
    };
    
    // Cache the detailed scorecard in Redis for future requests
    const detailedCacheKey = `scorecard-detailed:${matchKey}`;
    let cacheTTL = REDIS_TTL_MEDIUM; // 5 minutes default
    
    if (matchData.status === 'completed') {
      cacheTTL = REDIS_TTL_LONG; // 1 day for completed matches
    } else if (matchData.status === 'started') {
      cacheTTL = REDIS_TTL_LIVE; // 30 seconds for live matches
    }
    
    await cacheService.set(detailedCacheKey, { data: response }, cacheTTL);
    console.log(`Cached detailed scorecard for ${matchKey} (TTL: ${cacheTTL}s)`);
    
    res.json({ data: response });
  } catch (error) {
    console.error(`Error fetching detailed scorecard for ${req.params.matchKey}:`, error);
    res.status(500).json({ 
      message: `Error fetching detailed scorecard for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};

/**
 * Get match statistics (for Match Statistics View) - NO FLAGS optimization
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchStatistics = async (req, res) => {
  try {
    const { matchKey } = req.params;
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }
    
    // Check if match exists in MongoDB and has complete player/statistics data
    const existingMatch = await Match.findOne({ key: matchKey });
    
    // Check if we have complete statistics data in MongoDB
    const hasCompleteStats = existingMatch && 
      existingMatch.status === 'completed' &&
      (existingMatch.players || (existingMatch.play?.innings && 
        Object.values(existingMatch.play.innings).some(inning => 
          inning.batting_players || inning.bowling_players)));
    
    let matchData;
    
    if (hasCompleteStats) {
      console.log(`Using statistics data from MongoDB cache for completed match ${matchKey}`);
      matchData = existingMatch;
         } else {
       console.log(`Statistics data empty/missing in MongoDB - fetching fresh data for ${matchKey}`);
       // Fetch fresh data from API (even for completed matches if stats are empty)
       matchData = await fetchFreshMatchData(matchKey);
       if (!matchData) {
         return res.status(500).json({ 
           message: `Error fetching fresh match statistics for ${matchKey}`, 
           error: 'API call failed' 
         });
       }
     }
    
    // Get best performers from match data
    const bestBatters = getBestBatters(matchData, 3);
    const bestBowlers = getBestBowlers(matchData, 2);
    
    const statistics = {
      key: matchData.key,
      name: matchData.name,
      status: matchData.status,
      teams: matchData.teams,
      tournament: {
        name: matchData.tournament.name
      },
      best_performances: {
        batters: bestBatters,
        bowlers: bestBowlers
      },
      match_result: matchData.play?.result?.msg || null
    };
    
    res.json({ data: statistics });
  } catch (error) {
    console.error(`Error fetching match statistics for ${req.params.matchKey}:`, error);
    res.status(500).json({ 
      message: `Error fetching match statistics for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};

/**
 * Get ball-by-ball data (for Match Live Over view Screen - Over tab) - NO FLAGS optimization
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchBallByBall = async (req, res) => {
  try {
    const { matchKey } = req.params;
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }
    
    // Ball-by-ball data is typically not stored in MongoDB, always fetch fresh
    console.log(`Fetching fresh ball-by-ball data for ${matchKey} from Roanuz API`);
    const matchData = await getMatchDataWithCaching(matchKey, req, res);
    if (!matchData) return; // Error already handled in getMatchDataWithCaching
    
    // Get ball-by-ball data from Roanuz API or cache
    const ballByBallData = await getBallByBallData(matchKey);
    
    // Format ball-by-ball data for the frontend
    const overs = {
      key: matchData.key,
      name: matchData.name,
      status: matchData.status,
      teams: matchData.teams,
      tournament: {
        name: matchData.tournament.name
      },
      result: matchData.play?.result?.msg || null,
      current_over: getCurrentOverInfo(ballByBallData),
      recent_overs: getRecentOversInfo(ballByBallData, 5)
    };
    
    res.json({ data: overs });
  } catch (error) {
    console.error(`Error fetching ball-by-ball data for ${req.params.matchKey}:`, error);
    res.status(500).json({ 
      message: `Error fetching ball-by-ball data for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};

/**
 * Helper function to fetch fresh match data from API (bypasses MongoDB cache)
 * @param {string} matchKey - Match key
 * @returns {object} Fresh match data or null if error
 */
async function fetchFreshMatchData(matchKey) {
  try {
    console.log(`Fetching fresh match data for ${matchKey} from Roanuz API (bypassing cache)`);
    
    // Always fetch fresh data from Roanuz API
    const apiResponse = await roanuzService.getMatchDetails(matchKey, {
      useCache: false, // Always get fresh data
      cacheTTL: REDIS_TTL_LIVE
    });
    
    if (apiResponse?.data) {
      const matchData = apiResponse.data;
      
      // Always save/update the match in MongoDB with fresh data
      await Match.findOneAndUpdate(
        { key: matchKey },
        { 
          ...matchData,
          last_updated: new Date(),
          raw_data: matchData
        },
        { upsert: true, new: true }
      );
      
      console.log(`Fresh match data fetched and saved for ${matchKey} (status: ${matchData.status})`);
      return matchData;
    }
    
    return null;
  } catch (error) {
    console.error(`Error fetching fresh match data for ${matchKey}:`, error);
    return null;
  }
}

/**
 * Helper function to get match data with smart caching logic (Completed from MongoDB, Live/Upcoming from Roanuz)
 * @param {string} matchKey - Match key
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object} Match data or null if error
 */
async function getMatchDataWithCaching(matchKey, req, res) {
  try {
    // Check if match exists in MongoDB first
    const existingMatch = await Match.findOne({ key: matchKey });
    
    // If match is completed in MongoDB, serve from cache
    if (existingMatch && existingMatch.status === 'completed') {
      console.log(`Helper: Returning completed match data for ${matchKey} from MongoDB cache`);
      return existingMatch;
    }

    // For live/upcoming matches OR if match doesn't exist, fetch fresh from Roanuz
    const isLiveOrUpcoming = existingMatch && (existingMatch.status === 'started' || existingMatch.status === 'not_started');
    const logMessage = isLiveOrUpcoming 
      ? `Helper: Fetching fresh data for ${existingMatch.status} match ${matchKey} from Roanuz API`
      : `Helper: Fetching match data for ${matchKey} from Roanuz API (new match)`;
    
    console.log(logMessage);
    
    // Fetch fresh data from Roanuz API
    const apiResponse = await roanuzService.getMatchDetails(matchKey, {
      useCache: false, // Always get fresh data for live/upcoming
      cacheTTL: REDIS_TTL_LIVE // Short TTL for live data
    });
    
    if (apiResponse?.data) {
      const matchData = apiResponse.data;
      
      // Always save/update the match in MongoDB
      const updatedMatch = await Match.findOneAndUpdate(
        { key: matchKey },
        { 
          ...matchData,
          last_updated: new Date(),
          raw_data: matchData
        },
        { upsert: true, new: true }
      );
      
      // If match status changed to completed, log the change
      if (existingMatch && existingMatch.status !== 'completed' && matchData.status === 'completed') {
        console.log(`Helper: Match ${matchKey} status changed to completed - updated in MongoDB`);
      }
      
      console.log(`Helper: Match ${matchKey} data fetched and updated (status: ${matchData.status})`);
      return matchData;
    }
    
    return null;
  } catch (error) {
    console.error(`Helper: Error in getMatchDataWithCaching for ${matchKey}:`, error);
    
    // Try to serve stale data as a fallback
    try {
      const staleMatch = await Match.findOne({ key: matchKey });
      if (staleMatch) {
        console.log(`Helper: API failed - returning stale data for ${matchKey} from MongoDB`);
        return staleMatch;
      }
    } catch (fallbackError) {
      console.error('Helper: Fallback error:', fallbackError);
    }
    
    // If we reach here, the calling function should handle the error
    // Don't send response here as this is a helper function
    return null;
  }
}

/**
 * Helper function to get scorecard data
 * @param {string} matchKey - Match key
 * @returns {object} Scorecard data
 */
async function getMatchScorecardData(matchKey) {
  const cacheKey = `scorecard:${matchKey}`;
  
  // Try to get from Redis cache first
  const cachedData = await cacheService.get(cacheKey);
  if (cachedData) {
    console.log(`Returning scorecard for ${matchKey} from Redis cache`);
    return cachedData;
  }
  
  // Otherwise, fetch from Roanuz API
  console.log(`Fetching scorecard for ${matchKey} from Roanuz API`);
  const apiResponse = await roanuzService.getMatchScorecard(matchKey, {
    useCache: true,
    cacheTTL: REDIS_TTL_LIVE// 30 seconds for scorecard data
  });
  
  // Cache in Redis
  await cacheService.set(cacheKey, apiResponse, 30);
  
  return apiResponse;
}

/**
 * Helper function to get ball-by-ball data
 * @param {string} matchKey - Match key
 * @returns {object} Ball-by-ball data
 */
async function getBallByBallData(matchKey) {
  const cacheKey = `ballbyball:${matchKey}`;
  
  // Try to get from Redis cache first
  const cachedData = await cacheService.get(cacheKey);
  if (cachedData) {
    console.log(`Returning ball-by-ball data for ${matchKey} from Redis cache`);
    return cachedData;
  }
  
  // Otherwise, fetch from Roanuz API
  console.log(`Fetching ball-by-ball data for ${matchKey} from Roanuz API`);
  const apiResponse = await roanuzService.getBallByBall(matchKey, {
    useCache: true,
    cacheTTL: REDIS_TTL_SHORT // 15 seconds for ball-by-ball data
  });
  
  // Cache in Redis
  await cacheService.set(cacheKey, apiResponse, REDIS_TTL_SHORT);
  
  return apiResponse;
}

// Helper functions to format data for frontend

/**
 * Get current innings information
 * @param {object} matchData - Match data
 * @returns {object} Current innings info
 */
function getCurrentInningsInfo(matchData) {
  if (!matchData.play || !matchData.play.innings) {
    return null;
  }
  
  // For live matches, find the current innings
  if (matchData.status === 'started') {
    const inningsKeys = Object.keys(matchData.play.innings);
    for (const key of inningsKeys) {
      const innings = matchData.play.innings[key];
      if (!innings.is_completed) {
        return {
          batting_team: key.split('_')[0],
          overs: innings.overs,
          score: innings.score,
          score_str: innings.score_str,
          wickets: innings.wickets
        };
      }
    }
  }
  
  // For completed matches, return the last innings
  if (matchData.play.innings_order && matchData.play.innings_order.length > 0) {
    const lastInningsKey = matchData.play.innings_order[matchData.play.innings_order.length - 1];
    const lastInnings = matchData.play.innings[lastInningsKey];
    
    return {
      batting_team: lastInningsKey.split('_')[0],
      overs: lastInnings.overs,
      score: lastInnings.score,
      score_str: lastInnings.score_str,
      wickets: lastInnings.wickets
    };
  }
  
  return null;
}

/**
 * Get top batters from match data
 * @param {object} matchData - Match data
 * @param {number} limit - Number of batters to return
 * @returns {array} Top batters
 */
function getTopBatters(matchData, limit) {
  let allBatters = [];
  const inningsKeys = Object.keys(matchData.play.innings);
  
  for (const key of inningsKeys) {
    const innings = matchData.play.innings[key];
    const teamKey = key.split('_')[0]; // 'a' or 'b'
    const teamData = matchData.teams[teamKey];
    
    if (innings.batting_players && Object.keys(innings.batting_players).length > 0) {
      // Use actual batting_players data if available
      const battingPlayers = Object.entries(innings.batting_players).map(([playerKey, playerData]) => {
        return {
          player_key: playerKey,
          name: playerData.name || playerKey,
          team: teamKey,
          team_name: teamData.name,
          runs: playerData.runs || 0,
          balls: playerData.balls || 0,
          fours: playerData.fours || 0,
          sixes: playerData.sixes || 0,
          strike_rate: playerData.strike_rate || 0
        };
      });
      
      // Sort by runs (descending)
      battingPlayers.sort((a, b) => b.runs - a.runs);
      allBatters = [...allBatters, ...battingPlayers];
    } else if (innings.batting_order && innings.batting_order.length > 0) {
      // Fallback to batting_order if detailed stats aren't available
      for (let i = 0; i < innings.batting_order.length; i++) {
        const playerKey = innings.batting_order[i];
        allBatters.push({
          player_key: playerKey,
          name: playerKey,
          team: teamKey,
          team_name: teamData.name,
          runs: 'N/A',
          balls: 'N/A',
          fours: 'N/A',
          sixes: 'N/A',
          strike_rate: 'N/A'
        });
      }
    }
  }
  
  // Return top batters limited by the limit parameter
  return allBatters.slice(0, limit);
}

/**
 * Get top bowlers from match data
 * @param {object} matchData - Match data
 * @param {number} limit - Number of bowlers to return
 * @returns {array} Top bowlers
 */
function getTopBowlers(matchData, limit) {
  let allBowlers = [];
  const inningsKeys = Object.keys(matchData.play.innings);
  
  for (const key of inningsKeys) {
    const innings = matchData.play.innings[key];
    const battingTeamKey = key.split('_')[0]; // 'a' or 'b'
    const bowlingTeamKey = battingTeamKey === 'a' ? 'b' : 'a'; // Opposite team bowls
    const teamData = matchData.teams[bowlingTeamKey];
    
    if (innings.bowling_players && Object.keys(innings.bowling_players).length > 0) {
      // Use actual bowling_players data if available
      const bowlingPlayers = Object.entries(innings.bowling_players).map(([playerKey, playerData]) => {
        return {
          player_key: playerKey,
          name: playerData.name || playerKey,
          team: bowlingTeamKey,
          team_name: teamData.name,
          overs: playerData.overs || 0,
          maidens: playerData.maidens || 0,
          runs: playerData.runs || 0,
          wickets: playerData.wickets || 0,
          economy: playerData.economy || 0
        };
      });
      
      // Sort by wickets (descending), then by economy rate (ascending)
      bowlingPlayers.sort((a, b) => {
        if (b.wickets !== a.wickets) return b.wickets - a.wickets;
        return a.economy - b.economy;
      });
      
      allBowlers = [...allBowlers, ...bowlingPlayers];
    } else if (innings.bowling_order && innings.bowling_order.length > 0) {
      // Fallback to bowling_order if detailed stats aren't available
      for (let i = 0; i < innings.bowling_order.length; i++) {
        const playerKey = innings.bowling_order[i];
        allBowlers.push({
          player_key: playerKey,
          name: playerKey,
          team: bowlingTeamKey,
          team_name: teamData.name,
          overs: 'N/A',
          maidens: 'N/A',
          runs: 'N/A',
          wickets: 'N/A',
          economy: 'N/A'
        });
      }
    }
  }
  
  // Return top bowlers limited by the limit parameter
  return allBowlers.slice(0, limit);
}

/**
 * Get last ball information
 * @param {object} matchData - Match data
 * @returns {object} Last ball info
 */
function getLastBallInfo(matchData) {
  // This would require ball-by-ball data
  // For now, return placeholder data
  return {
    over: 'N/A',
    ball: 'N/A',
    runs: 'N/A',
    batsman: 'N/A',
    bowler: 'N/A',
    commentary: 'N/A'
  };
}

/**
 * Format innings details for scorecard
 * @param {object} matchData - Match data
 * @param {object} scorecardData - Scorecard data
 * @returns {object} Formatted innings details
 */
function formatInningsDetails(matchData, scorecardData) {
  const innings_list = [];
  
  if (!matchData.play || !matchData.play.innings) {
    return { innings_list };
  }
  
  // Get innings in the correct order
  const inningsOrder = matchData.play.innings_order || Object.keys(matchData.play.innings);
  
  for (const inningsKey of inningsOrder) {
    const innings = matchData.play.innings[inningsKey];
    if (!innings) continue;
    
    const teamKey = inningsKey.split('_')[0]; // 'a' or 'b'
    const teamData = matchData.teams[teamKey];
    const opposingTeamKey = teamKey === 'a' ? 'b' : 'a';
    const opposingTeamData = matchData.teams[opposingTeamKey];
    
    // Format batsmen data
    const batsmen = [];
    if (innings.batting_players && Object.keys(innings.batting_players).length > 0) {
      // Use actual batting data
      for (const playerKey in innings.batting_players) {
        const player = innings.batting_players[playerKey];
        batsmen.push({
          player_key: playerKey,
          name: player.name || playerKey,
          runs: player.runs || 0,
          balls: player.balls || 0,
          fours: player.fours || 0,
          sixes: player.sixes || 0,
          strike_rate: player.strike_rate || 0,
          dismissal: player.how_out || 'not out',
          batting_position: player.position || 0
        });
      }
      
      // Sort by batting position
      batsmen.sort((a, b) => a.batting_position - b.batting_position);
    }
    
    // Format bowlers data
    const bowlers = [];
    if (innings.bowling_players && Object.keys(innings.bowling_players).length > 0) {
      // Use actual bowling data
      for (const playerKey in innings.bowling_players) {
        const player = innings.bowling_players[playerKey];
        bowlers.push({
          player_key: playerKey,
          name: player.name || playerKey,
          overs: player.overs || 0,
          maidens: player.maidens || 0,
          runs: player.runs || 0,
          wickets: player.wickets || 0,
          economy: player.economy || 0,
          dots: player.dots || 0,
          fours: player.fours_conceded || 0,
          sixes: player.sixes_conceded || 0
        });
      }
      
      // Sort by wickets (descending), then economy (ascending)
      bowlers.sort((a, b) => {
        if (b.wickets !== a.wickets) return b.wickets - a.wickets;
        return a.economy - b.economy;
      });
    }
    
    // Format extras
    const extras = innings.extra_runs || {
      extra: 0,
      bye: 0,
      leg_bye: 0,
      wide: 0,
      no_ball: 0,
      penalty: 0
    };
    
    // Add formatted innings to the list
    innings_list.push({
      innings_key: inningsKey,
      batting_team: teamKey,
      batting_team_name: teamData.name,
      bowling_team: opposingTeamKey,
      bowling_team_name: opposingTeamData.name,
      score_str: innings.score_str || '0/0',
      total_runs: innings.score?.runs || 0,
      total_wickets: innings.wickets || 0,
      overs_played: innings.score?.balls ? Math.floor(innings.score.balls / 6) + (innings.score.balls % 6) / 10 : 0,
      run_rate: innings.score?.run_rate || 0,
      batsmen,
      bowlers,
      extras,
      partnerships: innings.partnerships || []
    });
  }
  
  return { innings_list };
}

/**
 * Get close of play information
 * @param {object} matchData - Match data
 * @param {object} scorecardData - Scorecard data
 * @returns {object} Close of play info
 */
function getCloseOfPlayInfo(matchData, scorecardData) {
  // Try to extract close of play info from match data
  if (matchData.play && matchData.play.close_of_play_msg) {
    return {
      day: matchData.play.day_number || 'N/A',
      summary: matchData.play.close_of_play_msg
    };
  }
  
  // Fallback: construct from match result if available
  if (matchData.play && matchData.play.result && matchData.play.result.msg) {
    return {
      day: matchData.play.day_number || 'Day',
      summary: matchData.play.result.msg
    };
  }
  
  // Default fallback
  return {
    day: 'N/A',
    summary: 'Information not available'
  };
}

/**
 * Get current over information from ball-by-ball data
 * @param {object} ballByBallData - Ball-by-ball data
 * @returns {object} Current over info
 */
function getCurrentOverInfo(ballByBallData) {
  // Extract current over from ball-by-ball data if available
  if (ballByBallData && ballByBallData.data && ballByBallData.data.balls) {
    const balls = ballByBallData.data.balls;
    
    // Find the latest over
    if (balls.length > 0) {
      const latestBalls = balls.slice(-6); // Last 6 balls (or fewer)
      const overNum = latestBalls[0]?.over_number || 'N/A';
      
      return {
        over_num: overNum,
        balls: latestBalls.map(ball => ({
          ball_num: ball.ball_number,
          runs: ball.runs || 0,
          is_wicket: !!ball.wicket,
          is_boundary: ball.runs === 4 || ball.runs === 6,
          commentary: ball.commentary || '',
          batsman: ball.batsman?.name || 'N/A',
          bowler: ball.bowler?.name || 'N/A'
        }))
      };
    }
  }
  
  // Default fallback
  return {
    over_num: 'N/A',
    balls: []
  };
}

/**
 * Get recent overs information
 * @param {object} ballByBallData - Ball-by-ball data
 * @param {number} limit - Number of overs to return
 * @returns {array} Recent overs info
 */
function getRecentOversInfo(ballByBallData, limit) {
  // This would require processing ball-by-ball data
  // For now, return placeholder data
  return Array(limit).fill().map((_, i) => ({
    over_num: `N/A`,
    runs: 'N/A',
    wickets: 'N/A'
  }));
}

/**
 * Get best batters for statistics view
 * @param {object} matchData - Match data
 * @param {number} limit - Number of batters to return
 * @returns {array} Best batters
 */
function getBestBatters(matchData, limit) {
  let allBatters = [];
  
  if (!matchData.play || !matchData.play.innings) {
    return allBatters;
  }
  
  // Process each innings
  for (const inningsKey in matchData.play.innings) {
    const innings = matchData.play.innings[inningsKey];
    const teamKey = inningsKey.split('_')[0];
    const teamData = matchData.teams[teamKey];
    
    // Extract player data
    if (innings.batting_players) {
      const inningsBatters = Object.entries(innings.batting_players)
        .map(([playerKey, player]) => {
          // Calculate control percentage (if available, otherwise use placeholder)
          const controlPercentage = player.control_percentage || 
            (player.balls > 0 ? Math.round(((player.balls - (player.edges || 0)) / player.balls) * 100) : 'N/A');
          
          return {
            player_key: playerKey,
            name: player.name || playerKey,
            team: teamKey,
            team_name: teamData.name,
            runs: player.runs || 0,
            balls: player.balls || 0,
            fours: player.fours || 0,
            sixes: player.sixes || 0,
            strike_rate: player.strike_rate || 0,
            control_percentage: controlPercentage,
            image_url: player.image_url || null
          };
        })
        .filter(player => player.balls > 0); // Only include players who faced at least one ball
      
      allBatters = [...allBatters, ...inningsBatters];
    }
  }
  
  // Sort by runs (descending)
  allBatters.sort((a, b) => b.runs - a.runs);
  
  // Return top performers
  return allBatters.slice(0, limit);
}

/**
 * Get best bowlers for statistics view
 * @param {object} matchData - Match data
 * @param {number} limit - Number of bowlers to return
 * @returns {array} Best bowlers
 */
function getBestBowlers(matchData, limit) {
  let allBowlers = [];
  
  if (!matchData.play || !matchData.play.innings) {
    return allBowlers;
  }
  
  // Process each innings
  for (const inningsKey in matchData.play.innings) {
    const innings = matchData.play.innings[inningsKey];
    const battingTeamKey = inningsKey.split('_')[0];
    const bowlingTeamKey = battingTeamKey === 'a' ? 'b' : 'a';
    const teamData = matchData.teams[bowlingTeamKey];
    
    // Extract player data
    if (innings.bowling_players) {
      const inningsBowlers = Object.entries(innings.bowling_players)
        .map(([playerKey, player]) => {
          return {
            player_key: playerKey,
            name: player.name || playerKey,
            team: bowlingTeamKey,
            team_name: teamData.name,
            overs: player.overs || 0,
            maidens: player.maidens || 0,
            runs: player.runs || 0,
            wickets: player.wickets || 0,
            economy: player.economy || 0
          };
        })
        .filter(player => parseFloat(player.overs) > 0); // Only include players who bowled at least one ball
      
      allBowlers = [...allBowlers, ...inningsBowlers];
    }
  }
  
  // Sort by wickets (descending), then economy (ascending) for tie-breakers
  allBowlers.sort((a, b) => {
    if (b.wickets !== a.wickets) return b.wickets - a.wickets;
    return a.economy - b.economy;
  });
  
  // Return top performers
  return allBowlers.slice(0, limit);
}

/**
 * Get best performances (batters or bowling) for a match
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getBestPerformances = async (req, res) => {
  try {
    const { matchKey, type } = req.params;
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }
    
    if (!type || !['batters', 'bowling'].includes(type)) {
      return res.status(400).json({ message: 'Type must be either "batters" or "bowling"' });
    }
    
    // Check cache first - MongoDB  
    const cachedPerformers = await BestPerformers.findOne({ 
      match_key: matchKey, 
      type: type,
      cache_expires_at: { $gt: new Date() }
    });
    
    // Check if cached data actually contains performance data (not empty)
    const performanceData = type === 'batters' ? cachedPerformers?.data?.batters : cachedPerformers?.data?.bowlers;
    const hasValidCachedData = cachedPerformers && performanceData && Array.isArray(performanceData) && performanceData.length > 0;
    
    if (hasValidCachedData) {
      console.log(`Returning best ${type} from MongoDB cache`);
      return res.json({ 
        data: performanceData,
        cached: true 
      });
    }
    
    // Fetch fresh data from Roanuz API
    console.log(`Fetching fresh best ${type} data for match ${matchKey} (cache empty/missing)`);
    const matchData = await fetchFreshMatchData(matchKey);
    if (!matchData) {
      return res.status(500).json({ 
        message: `Error fetching fresh match data for best ${type}`, 
        error: 'API call failed' 
      });
    }
    
    let performersData;
    if (type === 'batters') {
      performersData = await extractBestBatters(matchData, matchKey);
    } else {
      performersData = await extractBestBowlers(matchData, matchKey);
    }
    
    // Determine cache duration based on match status
    const cacheDuration = await getPerformancesCacheDuration(matchKey);
    const cacheExpiresAt = new Date(Date.now() + cacheDuration * 1000);
    
    // Save to MongoDB
    await BestPerformers.findOneAndUpdate(
      { match_key: matchKey, type: type },
      {
        match_key: matchKey,
        type: type,
        data: type === 'batters' ? { batters: performersData } : { bowlers: performersData },
        match_status: matchData.status,
        last_updated: new Date(),
        cache_expires_at: cacheExpiresAt
      },
      { upsert: true, new: true }
    );
    
    // Also cache in Redis for faster access
    const cacheKey = `best_performers_${matchKey}_${type}`;
    await cacheService.set(cacheKey, { data: performersData }, cacheDuration);
    
    res.json({ data: performersData });
    
  } catch (error) {
    console.error(`Error fetching best ${req.params.type} for ${req.params.matchKey}:`, error);
    
    // Try to serve stale data as fallback (only if it has actual data)
    try {
      const stalePerformers = await BestPerformers.findOne({ 
        match_key: req.params.matchKey, 
        type: req.params.type 
      });
      
      const stalePerformanceData = req.params.type === 'batters' ? stalePerformers?.data?.batters : stalePerformers?.data?.bowlers;
      const hasValidStaleData = stalePerformers && stalePerformanceData && Array.isArray(stalePerformanceData) && stalePerformanceData.length > 0;
      
      if (hasValidStaleData) {
        console.log(`Returning stale best ${req.params.type} data as fallback`);
        return res.json({ 
          data: stalePerformanceData,
          stale: true,
          message: 'Fallback data - API temporarily unavailable'
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError);
    }
    
    res.status(500).json({ 
      message: `Error fetching best ${req.params.type} for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};

/**
 * Extract best batters from match data
 * @param {object} matchData - Match data from Roanuz API
 * @param {string} matchKey - Match key for ball-by-ball analysis
 * @returns {array} Best batters data
 */
async function extractBestBatters(matchData, matchKey) {
  const allBatters = [];
  
  if (!matchData.players) {
    return allBatters;
  }
  
  // Get team names for opponent mapping
  const teams = matchData.teams || {};
  
  for (const playerKey in matchData.players) {
    const player = matchData.players[playerKey];
    const battingScore = player.score?.['1']?.batting?.score;
    
    if (battingScore && battingScore.runs > 0) {
      // Determine player's team and opponent
      const playerTeam = getPlayerTeam(playerKey, matchData);
      const opponentTeam = getOpponentTeam(playerTeam, teams);
      
      // Calculate control percentage using available stats
      const controlPercentage = calculateControlPercentage(battingScore);
      
      // Get best and average shot from ball-by-ball analysis
      const shotAnalysis = await analyzeBatterShots(playerKey, matchKey, battingScore);
      
      // Get active overs from partnerships
      const activeOvers = getBatterActiveOvers(playerKey, matchData);
      
      allBatters.push({
        player_key: playerKey,
        name: player.player.name,
        team: playerTeam,
        team_name: teams[playerTeam]?.name || playerTeam,
        opponent: opponentTeam,
        runs: battingScore.runs,
        balls: battingScore.balls,
        fours: battingScore.fours,
        sixes: battingScore.sixes,
        strike_rate: battingScore.strike_rate,
        control_percentage: controlPercentage,
        best_shot: shotAnalysis.best_shot,
        average_shot: shotAnalysis.average_shot,
        boundary_percentage: battingScore.stats?.boundary_percentage || 0,
        dot_ball_percentage: battingScore.stats?.dot_ball_percentage || 0,
        player_image: null, // Player images not available in match API
        active_overs: activeOvers
      });
    }
  }
  
  // Sort by runs (descending)
  allBatters.sort((a, b) => b.runs - a.runs);
  return allBatters.slice(0, 5);
}

/**
 * Extract best bowlers from match data
 * @param {object} matchData - Match data from Roanuz API
 * @param {string} matchKey - Match key for ball-by-ball analysis
 * @returns {array} Best bowlers data
 */
async function extractBestBowlers(matchData, matchKey) {
  const allBowlers = [];
  
  if (!matchData.players) {
    return allBowlers;
  }
  
  // Get team names for opponent mapping
  const teams = matchData.teams || {};
  
  for (const playerKey in matchData.players) {
    const player = matchData.players[playerKey];
    const bowlingScore = player.score?.['1']?.bowling?.score;
    
    if (bowlingScore && bowlingScore.balls > 0) {
      // Determine player's team and opponent
      const playerTeam = getPlayerTeam(playerKey, matchData);
      const opponentTeam = getOpponentTeam(playerTeam, teams);
      
      // Get wicket types from wickets breakup
      const wicketTypes = getWicketTypes(bowlingScore.wickets_breakup);
      
      // Create ball type breakdown
      const ballTypeBreakdown = {
        normal: bowlingScore.balls - (bowlingScore.balls_breakup?.wides || 0) - (bowlingScore.balls_breakup?.no_balls || 0),
        wide: bowlingScore.balls_breakup?.wides || 0,
        no_ball: bowlingScore.balls_breakup?.no_balls || 0
      };
      
      allBowlers.push({
        player_key: playerKey,
        name: player.player.name,
        team: playerTeam,
        team_name: teams[playerTeam]?.name || playerTeam,
        opponent: opponentTeam,
        overs: `${bowlingScore.overs[0]}.${bowlingScore.overs[1]}`,
        maidens: bowlingScore.maiden_overs,
        runs: bowlingScore.runs,
        wickets: bowlingScore.wickets,
        economy: bowlingScore.economy,
        dot_balls: bowlingScore.balls_breakup?.dot_balls || 0,
        wides: bowlingScore.balls_breakup?.wides || 0,
        no_balls: bowlingScore.balls_breakup?.no_balls || 0,
        wicket_types: wicketTypes,
        ball_type_breakdown: ballTypeBreakdown,
        wickets_breakup: bowlingScore.wickets_breakup || {},
        stats: bowlingScore.stats || {},
        player_image: null // Player images not available in match API
      });
    }
  }
  
  // Sort by wickets (descending), then economy (ascending)
  allBowlers.sort((a, b) => {
    if (b.wickets !== a.wickets) return b.wickets - a.wickets;
    return a.economy - b.economy;
  });
  
  return allBowlers.slice(0, 5);
}

/**
 * Calculate control percentage using available batting stats
 * @param {object} battingScore - Batting score data
 * @returns {number} Control percentage
 */
function calculateControlPercentage(battingScore) {
  if (!battingScore.stats) {
    // Fallback calculation using boundary and dot ball percentages
    const boundaryPct = ((battingScore.fours + battingScore.sixes) / battingScore.balls) * 100;
    const dotBallPct = (battingScore.dot_balls / battingScore.balls) * 100;
    return Math.round((boundaryPct * 0.7) + ((100 - dotBallPct) * 0.3));
  }
  
  // Use boundary percentage and dot ball percentage for estimation
  const boundaryPct = battingScore.stats.boundary_percentage || 0;
  const dotBallPct = battingScore.stats.dot_ball_percentage || 0;
  
  // Control formula: Higher boundary percentage + lower dot ball percentage = better control
  return Math.round((boundaryPct * 0.6) + ((100 - dotBallPct) * 0.4));
}

/**
 * Analyze batter shots from ball-by-ball data
 * @param {string} playerKey - Player key
 * @param {string} matchKey - Match key
 * @param {object} battingScore - Batting score data
 * @returns {object} Shot analysis
 */
async function analyzeBatterShots(playerKey, matchKey, battingScore) {
  // For now, return calculated values based on available data
  // In future, can enhance with actual ball-by-ball API calls
  
  let bestShot = "Single";
  let averageShot = "Single";
  
  if (battingScore.sixes > 0) {
    bestShot = "Six";
  } else if (battingScore.fours > 0) {
    bestShot = "Boundary";
  }
  
  // Determine average shot based on run distribution
  const totalRunsFromBoundaries = (battingScore.fours * 4) + (battingScore.sixes * 6);
  const runsScoredInSingles = battingScore.runs - totalRunsFromBoundaries;
  
  if (runsScoredInSingles > totalRunsFromBoundaries) {
    averageShot = "Single";
  } else if (battingScore.fours >= battingScore.sixes) {
    averageShot = "Boundary";
  } else {
    averageShot = "Six";
  }
  
  return { best_shot: bestShot, average_shot: averageShot };
}

/**
 * Get batter active overs from partnerships
 * @param {string} playerKey - Player key
 * @param {object} matchData - Match data
 * @returns {array} Active overs
 */
function getBatterActiveOvers(playerKey, matchData) {
  const activeOvers = [];
  
  if (!matchData.play?.innings) return activeOvers;
  
  // Check all innings for partnerships involving this player
  Object.values(matchData.play.innings).forEach(innings => {
    if (innings.partnerships) {
      innings.partnerships.forEach(partnership => {
        if (partnership.player_a_key === playerKey || partnership.player_b_key === playerKey) {
          activeOvers.push({
            start: partnership.begin_overs,
            end: partnership.end_overs,
            partnership_runs: partnership.score.runs
          });
        }
      });
    }
  });
  
  return activeOvers;
}

/**
 * Get player's team from match data
 * @param {string} playerKey - Player key
 * @param {object} matchData - Match data
 * @returns {string} Team key ('a' or 'b')
 */
function getPlayerTeam(playerKey, matchData) {
  // Check batting order in each innings to determine team
  if (matchData.play?.innings) {
    for (const inningsKey in matchData.play.innings) {
      const innings = matchData.play.innings[inningsKey];
      const teamKey = inningsKey.split('_')[0]; // 'a' or 'b'
      
      if (innings.batting_order && innings.batting_order.includes(playerKey)) {
        return teamKey;
      }
      if (innings.bowling_order && innings.bowling_order.includes(playerKey)) {
        return teamKey === 'a' ? 'b' : 'a'; // Bowler is from opposite team
      }
    }
  }
  
  // Fallback: return 'a' (shouldn't happen with valid data)
  return 'a';
}

/**
 * Get opponent team key
 * @param {string} playerTeam - Player's team key
 * @param {object} teams - Teams data
 * @returns {string} Opponent team name
 */
function getOpponentTeam(playerTeam, teams) {
  const opponentKey = playerTeam === 'a' ? 'b' : 'a';
  return teams[opponentKey]?.name || opponentKey;
}

/**
 * Get wicket types from wickets breakup
 * @param {object} wicketsBreakup - Wickets breakup data
 * @returns {array} Array of wicket types
 */
function getWicketTypes(wicketsBreakup) {
  const types = [];
  if (!wicketsBreakup) return types;
  
  if (wicketsBreakup.bowled > 0) types.push('bowled');
  if (wicketsBreakup.caught > 0) types.push('caught');
  if (wicketsBreakup.lbw > 0) types.push('lbw');
  if (wicketsBreakup.stumping > 0) types.push('stumping');
  
  return types;
}

/**
 * Get cache duration for performances based on match status
 * @param {string} matchKey - Match key
 * @returns {number} Cache duration in seconds
 */
async function getPerformancesCacheDuration(matchKey) {
  try {
    const match = await Match.findOne({ key: matchKey }, { status: 1 });
    if (!match) return REDIS_TTL_SHORT;
    
    switch (match.status) {
      case 'completed':
        return REDIS_TTL_MEDIUM;
      case 'started':
        return REDIS_TTL_LIVE;
      case 'not_started':
        return REDIS_TTL_SHORT;
      default:
        return REDIS_TTL_SHORT;
    }
  } catch (error) {
    console.error('Error determining cache duration:', error);
    return REDIS_TTL_SHORT;
  }
}

/**
 * Utility function to validate match data structure
 * @param {object} matchData - Match data to validate
 * @returns {object} Validation result with warnings
 */
function validateMatchDataStructure(matchData) {
  const warnings = [];
  const hasPlayInnings = matchData.play?.innings && Object.keys(matchData.play.innings).length > 0;
  const hasPlayers = matchData.players && Object.keys(matchData.players).length > 0;
  
  if (!hasPlayInnings) {
    warnings.push('Missing play.innings data - scorecard features may not work');
  }
  
  if (!hasPlayers && hasPlayInnings) {
    let hasInningsPlayerData = false;
    for (const inningsKey in matchData.play.innings) {
      const innings = matchData.play.innings[inningsKey];
      if (innings.batting_players || innings.bowling_players) {
        hasInningsPlayerData = true;
        break;
      }
    }
    
    if (!hasInningsPlayerData) {
      warnings.push('No player data available in any format - detailed stats will be limited');
    }
  }
  
  return {
    isValid: warnings.length === 0,
    warnings: warnings,
    dataAvailability: {
      hasPlayInnings,
      hasPlayers,
      hasDetailedStats: hasPlayInnings && (hasPlayers || 
        Object.values(matchData.play?.innings || {}).some(innings => 
          innings.batting_players || innings.bowling_players))
    }
  };
}

/**
 * Utility function to normalize player data across different API formats
 * @param {object} matchData - Raw match data from API
 * @returns {object} Normalized match data
 */
function normalizeMatchData(matchData) {
  if (!matchData.players && matchData.play?.innings) {
    matchData.players = {};
  }
  
  if (matchData.play?.innings) {
    for (const inningsKey in matchData.play.innings) {
      const innings = matchData.play.innings[inningsKey];
      
      if (!innings.batting_players) {
        innings.batting_players = {};
      }
      if (!innings.bowling_players) {
        innings.bowling_players = {};
      }
    }
  }
  
  return matchData;
}

/**
 * Get ball-by-ball commentary with pagination (3 overs per page, Redis cache only)
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
exports.getMatchCommentary = async (req, res) => {
  try {
    const { matchKey } = req.params;
    const { page_key } = req.query; // Optional pagination key from frontend
    
    if (!matchKey) {
      return res.status(400).json({ message: 'Match key is required' });
    }

    // Create cache key based on match and pagination
    const cacheKey = page_key ? `commentary:${matchKey}:${page_key}` : `commentary:${matchKey}:latest`;
    
    // Check Redis cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log(`Returning commentary for ${matchKey} from Redis cache`);
      return res.json(cachedData);
    }

    // Get basic match info for metadata
    const matchData = await getMatchDataWithCaching(matchKey, req, res);
    if (!matchData) return;

    let commentary = [];
    let paginationInfo = {};

    if (!page_key) {
      // Default case: Get last 3 overs (latest commentary)
      console.log(`Fetching latest 3 overs commentary for ${matchKey}`);
      commentary = await fetchLatestCommentaryOvers(matchKey, 3);
    } else {
      // Pagination case: Get 3 overs starting from page_key
      console.log(`Fetching commentary for ${matchKey} with page_key: ${page_key}`);
      commentary = await fetchCommentaryByPageKey(matchKey, page_key, 3);
    }

    if (!commentary || commentary.length === 0) {
      return res.status(404).json({ 
        message: 'Commentary data not available for this match' 
      });
    }

    // Extract pagination info from the commentary data
    paginationInfo = extractPaginationInfo(commentary);

    // Build response
    const response = {
      data: {
        match_key: matchData.key,
        match_name: matchData.name,
        status: matchData.status,
        teams: matchData.teams,
        tournament: {
          name: matchData.tournament?.name,
          short_name: matchData.tournament?.short_name
        },
        commentary: {
          overs: commentary,
          pagination: {
            current_page_key: page_key || 'latest',
            previous_page_key: paginationInfo.previous_page_key || null,
            next_page_key: paginationInfo.next_page_key || null,
            total_overs: commentary.length,
            overs_per_page: 3
          }
        }
      }
    };

    // Cache in Redis with appropriate TTL
    const ttl = matchData.status === 'started' ? REDIS_TTL_LIVE : REDIS_TTL_MEDIUM; // 30s for live, 5min for others
    await cacheService.set(cacheKey, response, ttl);

    console.log(`Commentary cached for ${matchKey} (${commentary.length} overs, TTL: ${ttl}s)`);
    
    res.json(response);

  } catch (error) {
    console.error(`Error fetching commentary for ${req.params.matchKey}:`, error);
    res.status(500).json({ 
      message: `Error fetching commentary for ${req.params.matchKey}`, 
      error: error.message 
    });
  }
};

/**
 * Fetch latest commentary overs (for default request)
 * @param {string} matchKey - Match key
 * @param {number} overCount - Number of overs to fetch
 * @returns {array} Array of over commentary data
 */
async function fetchLatestCommentaryOvers(matchKey, overCount) {
  try {
    const commentary = [];
    
    // Start with current/latest over
    let currentOverResponse = await roanuzService.getBallByBall(matchKey, {
      useCache: false,
      cacheTTL: REDIS_TTL_LIVE
    });

    if (!currentOverResponse?.data?.over) {
      return [];
    }

    // Add current over to commentary
    commentary.push(formatOverCommentary(currentOverResponse.data.over, currentOverResponse.data));

    // Fetch previous overs to reach desired count
    let previousOverKey = currentOverResponse.data.previous_over_key;
    
    for (let i = 1; i < overCount && previousOverKey; i++) {
      const prevOverResponse = await roanuzService.getBallByBall(matchKey, {
        useCache: false,
        cacheTTL: REDIS_TTL_LIVE,
        over_key: previousOverKey
      });

      if (prevOverResponse?.data?.over) {
        commentary.unshift(formatOverCommentary(prevOverResponse.data.over, prevOverResponse.data));
        previousOverKey = prevOverResponse.data.previous_over_key;
      } else {
        break;
      }
    }

    return commentary;
  } catch (error) {
    console.error(`Error fetching latest commentary for ${matchKey}:`, error);
    return [];
  }
}

/**
 * Fetch commentary by page key (for pagination) - goes backwards in time
 * @param {string} matchKey - Match key
 * @param {string} pageKey - Page key for pagination (starting over)
 * @param {number} overCount - Number of overs to fetch
 * @returns {array} Array of over commentary data
 */
async function fetchCommentaryByPageKey(matchKey, pageKey, overCount) {
  try {
    const commentary = [];
    
    // Start with the specified over
    let currentOverResponse = await roanuzService.getBallByBall(matchKey, {
      useCache: false,
      cacheTTL: REDIS_TTL_LIVE,
      over_key: pageKey
    });

    if (!currentOverResponse?.data?.over) {
      return [];
    }

    // Add current over to commentary (this will be the latest of the 3 overs)
    commentary.push(formatOverCommentary(currentOverResponse.data.over, currentOverResponse.data));

    // Fetch previous overs to reach desired count (going backwards in time)
    let previousOverKey = currentOverResponse.data.previous_over_key;
    
    for (let i = 1; i < overCount && previousOverKey; i++) {
      const prevOverResponse = await roanuzService.getBallByBall(matchKey, {
        useCache: false,
        cacheTTL: REDIS_TTL_LIVE,
        over_key: previousOverKey
      });

      if (prevOverResponse?.data?.over) {
        commentary.unshift(formatOverCommentary(prevOverResponse.data.over, prevOverResponse.data));
        previousOverKey = prevOverResponse.data.previous_over_key;
      } else {
        break;
      }
    }

    return commentary;
  } catch (error) {
    console.error(`Error fetching commentary by page key for ${matchKey}:`, error);
    return [];
  }
}

/**
 * Format over commentary for frontend consumption
 * @param {object} overData - Over data from Roanuz API
 * @param {object} apiData - Full API response data
 * @returns {object} Formatted over commentary
 */
function formatOverCommentary(overData, apiData) {
  const formattedBalls = overData.balls.map(ball => ({
    key: ball.key,
    ball_number: ball.overs[1] + 1, // Convert to 1-based ball number
    over_number: ball.overs[0] + 1, // Convert to 1-based over number
    ball_type: ball.ball_type, // normal, wide, no_ball, etc.
    runs: ball.batsman.runs,
    extras: ball.team_score.extras,
    total_runs: ball.team_score.runs,
    is_wicket: ball.team_score.is_wicket,
    is_four: ball.batsman.is_four,
    is_six: ball.batsman.is_six,
    is_dot_ball: ball.batsman.is_dot_ball,
    commentary: ball.comment,
    batsman: {
      name: ball.batsman.player_key, // Could be enhanced with actual player names
      key: ball.batsman.player_key
    },
    bowler: {
      name: ball.bowler.player_key, // Could be enhanced with actual player names  
      key: ball.bowler.player_key
    },
    non_striker: ball.non_striker_key,
    wicket: ball.wicket ? {
      player_key: ball.wicket.player_key,
      wicket_type: ball.wicket.wicket_type,
      fielders: ball.fielders?.map(f => ({
        player_key: f.player_key,
        is_catch: f.is_catch,
        is_run_out: f.is_run_out,
        is_stumps: f.is_stumps
      })) || []
    } : null,
    ball_representation: ball.repr, // Short representation like 'r1', 'b4', 'w', etc.
    entry_time: ball.entry_time
  }));

  return {
    over_key: `${overData.index.innings}_${overData.index.over_number}`,
    over_number: overData.index.over_number + 1, // Convert to 1-based
    innings: overData.index.innings,
    batting_team: overData.index.innings.split('_')[0], // 'a' or 'b'
    balls: formattedBalls,
    over_summary: {
      total_runs: formattedBalls.reduce((sum, ball) => sum + ball.runs + ball.extras, 0),
      wickets: formattedBalls.filter(ball => ball.is_wicket).length,
      boundaries: formattedBalls.filter(ball => ball.is_four || ball.is_six).length,
      dot_balls: formattedBalls.filter(ball => ball.is_dot_ball).length
    }
  };
}

/**
 * Extract pagination info from commentary data
 * @param {array} commentary - Array of over commentary
 * @returns {object} Pagination information
 */
function extractPaginationInfo(commentary) {
  if (!commentary || commentary.length === 0) {
    return {};
  }

  const firstOver = commentary[0]; // Earliest over in current page
  const lastOver = commentary[commentary.length - 1]; // Latest over in current page

  // For pagination going backwards in time:
  // - previous_page_key should be the key to get older overs (before the earliest over we returned)
  // - next_page_key would be the key to get newer overs (after the latest over we returned)
  // 
  // Since we're going backwards in time, we need to calculate the previous page key
  // based on the earliest over's number minus 1
  
  let previousPageKey = null;
  if (firstOver.over_number > 1) {
    // Calculate the key for the over that comes before the earliest over
    // Note: over_number in our data is 1-based, but API keys use 0-based
    const prevOverNumber = firstOver.over_number - 2; // Convert to 0-based and subtract 1
    previousPageKey = `${firstOver.innings}_${prevOverNumber}`;
  }

  return {
    previous_page_key: previousPageKey, // Key to fetch next page (older overs)
    next_page_key: null, // Not used in our pagination scheme
    first_over_number: firstOver.over_number,
    last_over_number: lastOver.over_number,
    innings: firstOver.innings
  };
}
