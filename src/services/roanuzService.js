const axios = require('axios');
const { ROANUZ_API_URL, ROANUZ_PROJ_KEY, REDIS_TTL_SHORT, REDIS_TTL_MEDIUM, REDIS_TTL_LONG, REDIS_TTL_LIVE } = require('../config/constants');
const authService = require('./authService');
const cacheService = require('./cacheService');
// function logAxiosError(err, fullUrl) {
//   if (err.response) {
//     console.error(`HTTP ${err.response.status} from ${fullUrl}`);
//     console.error('Response headers:', err.response.headers);
//     try {
//       // Pretty print JSON if possible
//       console.error('Response data:', JSON.stringify(err.response.data, null, 2));
//     } catch (_) {
//       console.error('Response data (raw):', err.response.data);
//     }
//   } else if (err.request) {
//     console.error('No response received from', fullUrl);
//   } else {
//     console.error('Request config error:', err.message);
//   }
// }

/**
 * Roanuz API Service
 * Handles all API requests to the Roanuz Cricket API
 */
class RoanuzService {
  constructor() {
    console.log('Initializing Roanuz API Service');
    console.log(`API URL: ${ROANUZ_API_URL}`);
    console.log(`Project Key: ${ROANUZ_PROJ_KEY}`);
  }

  /**
   * Create an axios instance with authentication headers
   * @returns {Promise<AxiosInstance>} Configured axios instance
   */
  async createApiClient() {
    const headers = await authService.getAuthHeaders();
    console.log('Creating API client with headers:', JSON.stringify(headers));
    return axios.create({
      baseURL: ROANUZ_API_URL,
      headers
    });
  }

  /**
   * Make an authenticated API request
   * @param {string} method - HTTP method
   * @param {string} url - API endpoint
   * @param {Object} data - Request data (for POST, PUT, etc.)
   * @param {Object} options - Additional options
   * @param {boolean} options.useCache - Whether to use cache
   * @param {number} options.cacheTTL - Cache TTL in seconds
   * @returns {Promise<Object>} API response
   */
  async makeRequest(method, url, data = null, options = {}) {
    const { useCache = true, cacheTTL = REDIS_TTL_SHORT } = options;
    const cacheKey = `roanuz:${method}:${url}:${data ? JSON.stringify(data) : ''}`;
    
    try {
      // Try to get from cache first if caching is enabled
      if (useCache) {
        const cachedData = await cacheService.get(cacheKey);
        if (cachedData) {
          console.log(`Cache hit for ${url}`);
          return cachedData;
        }
        console.log(`Cache miss for ${url}`);
      }
      
      const apiClient = await this.createApiClient();
      const fullUrl = `${ROANUZ_API_URL}${url}`;
      console.log(`Making ${method.toUpperCase()} request to: ${fullUrl}`);
      
      const config = { method, url };
      if (data) {
        config.data = data;
      }

      const response = await apiClient(config);
      
      // Cache the response if caching is enabled
      if (useCache && response.data) {
        let ttl = cacheTTL;
        
        // If Roanuz provides cache info, use that instead
        if (response.data.cache) {
          if (response.data.cache.expires) {
            // If expires timestamp is provided, calculate TTL as (expires - current time)
            const expiresMs = response.data.cache.expires * 1000; // Convert to milliseconds
            const currentMs = Date.now();
            if (expiresMs > currentMs) {
              ttl = Math.floor((expiresMs - currentMs) / 1000); // Convert back to seconds
            }
          } else if (response.data.cache.max_age) {
            // If max_age is provided in seconds, use that directly
            ttl = response.data.cache.max_age;
          }
        }
        
        console.log(`Caching response for ${url} with TTL: ${ttl}s`);
        await cacheService.set(cacheKey, response.data, ttl);
      }
      
      return response.data;
    } catch (error) {
      console.error(`Error1 making ${method} request to ${url}:`, error.message);
      // console.error('Full URL2:', `${ROANUZ_API_URL}${url}`);
      // console.error('Full URL1:', fullUrl);
      // console.error("Actual error is",error);

   
    // logAxiosError(error, fullUrl);
      
      // Handle authentication errors
      if (error.response && error.response.status === 401) {
        console.log('Authentication error, trying to refresh token...');
        await authService.forceRefreshToken();
        
        // Retry the request once with new token
        const apiClient = await this.createApiClient();
        const config = { method, url };
        if (data) {
          config.data = data;
        }
        
        const response = await apiClient(config);
        
        // Cache the response if caching is enabled
        if (useCache && response.data) {
          let ttl = cacheTTL;
          
          // If Roanuz provides cache info, use that instead
          if (response.data.cache) {
            if (response.data.cache.expires) {
              // If expires timestamp is provided, calculate TTL as (expires - current time)
              const expiresMs = response.data.cache.expires * 1000; // Convert to milliseconds
              const currentMs = Date.now();
              if (expiresMs > currentMs) {
                ttl = Math.floor((expiresMs - currentMs) / 1000); // Convert back to seconds
              }
            } else if (response.data.cache.max_age) {
              // If max_age is provided in seconds, use that directly
              ttl = response.data.cache.max_age;
            }
          }
          
          await cacheService.set(cacheKey, response.data, ttl);
        }
        
        return response.data;
      }
      
      throw error;
    }
  }

  // async makeRequest(method, url, data = null, options = {}) {
  //   const { useCache = true, cacheTTL = REDIS_TTL_SHORT } = options;
  
  //   // Make a stable cache key (differs by method + url + body)
  //   const cacheKey = `roanuz:${method}:${url}:${data ? JSON.stringify(data) : ''}`;
  
  //   // ⬇️ Declare fullUrl here so it’s visible in try + catch
  //   const fullUrl = `${ROANUZ_API_URL}${url}`;
  
  //   try {
  //     // 1) Cache (if enabled)
  //     if (useCache) {
  //       const cachedData = await cacheService.get(cacheKey);
  //       if (cachedData) {
  //         console.log(`Cache hit for ${url}`);
  //         return cachedData;
  //       }
  //       console.log(`Cache miss for ${url}`);
  //     }
  
  //     // 2) Axios instance with rs-token + baseURL
  //     const apiClient = await this.createApiClient();
  
  //     console.log(`Making ${method.toUpperCase()} request to: ${fullUrl}`);
  
  //     const config = { method, url };          // url is RELATIVE; baseURL is on the instance
  //     if (data !== null) config.data = data;   // send JSON body for POST/PUT
  
  //     // 3) Execute request
  //     const response = await apiClient(config);
  
  //     // 4) Cache positive responses (optional; honor Roanuz cache hints)
  //     if (useCache && response.data) {
  //       let ttl = cacheTTL;
  //       const rc = response.data.cache;
  //       if (rc) {
  //         if (rc.expires) {
  //           const diffSec = Math.floor((rc.expires * 1000 - Date.now()) / 1000);
  //           if (diffSec > 0) ttl = diffSec;
  //         } else if (rc.max_age) {
  //           ttl = rc.max_age;
  //         }
  //       }
  //       console.log(`Caching response for ${url} with TTL: ${ttl}s`);
  //       await cacheService.set(cacheKey, response.data, ttl);
  //     }
  
  //     return response.data;
  //   } catch (error) {
  //     // ⬇️ You can safely use fullUrl here now
  //     console.error(`Error making ${method} request to ${url}: ${error.message}`);
  //     console.error('Full URL:', fullUrl);
  
  //     // Print raw axios error object bits (often useful)
  //     if (error.response) {
  //       console.error('Status:', error.response.status);
  //       console.error('Headers:', error.response.headers);
  //       console.error('Body:', JSON.stringify(error.response.data, null, 2)); // <-- The main thing you wanted
  //     } else if (error.request) {
  //       console.error('No response received from server.');
  //     }
  
  //     // Pretty helper (duplicates some info but formats nicely)
  //     logAxiosError(error, fullUrl);
  
  //     // Token expiry path: refresh once and retry
  //     if (error.response && error.response.status === 401) {
  //       console.log('Authentication error, trying to refresh token...');
  //       await authService.forceRefreshToken();
  
  //       const apiClient = await this.createApiClient();
  //       const retryConfig = { method, url };
  //       if (data !== null) retryConfig.data = data;
  
  //       const response = await apiClient(retryConfig);
  
  //       if (useCache && response.data) {
  //         let ttl = cacheTTL;
  //         const rc = response.data.cache;
  //         if (rc) {
  //           if (rc.expires) {
  //             const diffSec = Math.floor((rc.expires * 1000 - Date.now()) / 1000);
  //             if (diffSec > 0) ttl = diffSec;
  //           } else if (rc.max_age) {
  //             ttl = rc.max_age;
  //           }
  //         }
  //         await cacheService.set(cacheKey, response.data, ttl);
  //       }
  //       return response.data;
  //     }
  
  //     // Re-throw to upstream
  //     throw error;
  //   }
  // }

  /**
   * Get featured matches
   * @param {Object} options - Cache options
   * @returns {Promise} Featured matches data
   */
  async getFeaturedMatches(options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/featured-matches-2/`;
      console.log(`Fetching featured matches with URL: ${url}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error('Error fetching featured matches:', error.message);
      throw error;
    }
  }

  /**
   * Get featured tournaments
   * @param {Object} options - Cache options
   * @returns {Promise} Featured tournaments data
   */
  async getFeaturedTournaments(options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/featured-tournaments/`;
      console.log(`Fetching featured tournaments with URL: ${url}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error('Error fetching featured tournaments:', error.message);
      throw error;
    }
  }

  /**
   * Get associations list
   * @param {Object} options - Cache options
   * @returns {Promise} List of cricket associations
   */
  async getAssociations(options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/associations/`;
      console.log(`Fetching associations with URL: ${url}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_MEDIUM,
        ...options
      });
    } catch (error) {
      console.error('Error fetching associations:', error.message);
      throw error;
    }
  }

  /**
   * Get association tournaments
   * @param {string} associationKey - The unique key for the association
   * @param {Object} options - Cache options
   * @returns {Promise} Association tournaments data
   */
  async getAssociationTournaments(associationKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/association/${associationKey}/tournaments/`;
      console.log(`Fetching tournaments for association ${associationKey}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching tournaments for association ${associationKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get match details by match key
   * @param {string} matchKey - The unique key for the match
   * @param {Object} options - Cache options
   * @returns {Promise} Match details
   */
  async getMatchDetails(matchKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/match/${matchKey}/`;
      // Default TTL based on match status (will be overridden by Roanuz cache info if available)
      let cacheTTL = REDIS_TTL_SHORT;
      
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching match details for ${matchKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get match scorecard
   * @param {string} matchKey - The unique key for the match
   * @param {Object} options - Cache options
   * @returns {Promise} Match scorecard data
   */
  async getMatchScorecard(matchKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/match/${matchKey}/scorecard/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_LIVE,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching scorecard for match ${matchKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get ball-by-ball details for a match
   * @param {string} matchKey - The unique key for the match
   * @param {Object} options - Cache options and API parameters
   * @param {string} options.over_key - Optional over key for pagination (e.g., 'b_1_19')
   * @returns {Promise} Ball-by-ball data
   */
  async getBallByBall(matchKey, options = {}) {
    try {
      let url = `/cricket/${ROANUZ_PROJ_KEY}/match/${matchKey}/ball-by-ball/`;
      
      // Add over_key to URL path if provided for pagination
      if (options.over_key) {
        url += `${options.over_key}/`;
      }
      
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_LIVE,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching ball-by-ball data for match ${matchKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get tournament details
   * @param {string} tournamentKey - The unique key for the tournament
   * @param {Object} options - Cache options
   * @returns {Promise} Tournament details
   */
  async getTournamentDetails(tournamentKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/tournament/${tournamentKey}/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching tournament details for ${tournamentKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get tournament points table
   * @param {string} tournamentKey - The unique key for the tournament
   * @param {Object} options - Cache options
   * @returns {Promise} Tournament points table data
   */
  async getTournamentPointsTable(tournamentKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/tournament/${tournamentKey}/points-table/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching points table for tournament ${tournamentKey}:`, error.message);
      throw error;
    }
  }
  
  /**
   * Get tournament fixtures
   * @param {string} tournamentKey - The unique key for the tournament
   * @param {Object} options - Cache options
   * @returns {Promise} Tournament fixtures data
   */
  async getTournamentFixtures(tournamentKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/tournament/${tournamentKey}/fixtures/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching fixtures for tournament ${tournamentKey}:`, error.message);
      throw error;
    }
  }
  
  /**
   * Get tournament featured matches
   * @param {string} tournamentKey - The unique key for the tournament
   * @param {Object} options - Cache options
   * @returns {Promise} Tournament featured matches data
   */
  async getTournamentFeaturedMatches(tournamentKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/tournament/${tournamentKey}/featured-matches/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching featured matches for tournament ${tournamentKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get tournament matches
   * @param {string} tournamentKey - The unique key for the tournament
   * @param {Object} options - Cache options
   * @returns {Promise} Tournament matches data
   */
  async getTournamentMatches(tournamentKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/tournament/${tournamentKey}/matches/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching tournament matches for ${tournamentKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get team details
   * @param {string} teamKey - The unique key for the team
   * @param {Object} options - Cache options
   * @returns {Promise} Team details
   */
  async getTeamDetails(teamKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/team/${teamKey}/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_MEDIUM,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching team details for ${teamKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get player details
   * @param {string} playerKey - The unique key for the player
   * @param {Object} options - Cache options
   * @returns {Promise} Player details
   */
  async getPlayerDetails(playerKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/player/${playerKey}/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_MEDIUM,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching player details for ${playerKey}:`, error.message);
      throw error;
    }
  }

  /**
   * Get country flag
   * @param {string} countryCode - The ISO country code
   * @param {Object} options - Cache options
   * @returns {Promise} Country flag data
   */
  async getCountryFlag(countryCode, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/country/${countryCode}/flags/`;
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_LONG,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching flag for country ${countryCode}:`, error.message);
      throw error;
    }
  }

  /**
   * Get countries list
   * @param {Object} options - Cache options
   * @returns {Promise} Countries list data
   */
  async getCountriesList(options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/country/list/`;
      console.log(`Fetching countries list with URL: ${url}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_LONG,
        ...options
      });
    } catch (error) {
      console.error('Error fetching countries list:', error.message);
      throw error;
    }
  }

  /**
   * Get tournament team players
   * @param {string} tournamentKey - The unique key for the tournament
   * @param {string} teamKey - The unique key for the team
   * @param {Object} options - Cache options
   * @returns {Promise} Tournament team players data
   */
  async getTournamentTeamPlayers(tournamentKey, teamKey, options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/tournament/${tournamentKey}/team/${teamKey}/`;
      console.log(`Fetching players for team ${teamKey} in tournament ${tournamentKey}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching players for team ${teamKey} in tournament ${tournamentKey}:`, error.message);
      throw error;
    }
  }
  /**
   * Get aggregated cricket news
   * @param {Object} options - Cache options
   * @returns {Promise} Aggregated cricket news data
   */

  async getNews(options = {}) {
    try {
      const url = `/cricket/${ROANUZ_PROJ_KEY}/news-aggregation/`;
      console.log(`Fetching featured matches with URL: ${url}`);
      return await this.makeRequest('get', url, null, {
        useCache: true,
        cacheTTL: REDIS_TTL_MEDIUM,
        ...options
      });
    } catch (error) {
      console.error(`Error fetching news`, error.message);
      throw error;
    }
  }

   // ======================= NEW: Webhook helpers =======================
  /**
   * Subscribe to a match for webhook updates
   * - Uses POST /match/{matchKey}/subscribe/
   * - No caching (push-registration call)
   */
  async subscribeToMatch(matchKey) {
    // Keeping the shape consistent with your other methods
    const url = `/cricket/${ROANUZ_PROJ_KEY}/match/${matchKey}/subscribe/`;
    // Disable cache explicitly; axios will send JSON & include rs-token from createApiClient()
    return await this.makeRequest('post', url, { method: 'web_hook' }, { useCache: false });
  }

  /**
   * Unsubscribe from a match webhook
   * - Uses POST /match/{matchKey}/unsubscribe/
   * - No caching
   */
  async unsubscribeFromMatch(matchKey) {
    const url = `/cricket/${ROANUZ_PROJ_KEY}/match/${matchKey}/unsubscribe/`;
    return await this.makeRequest('post', url, { method: 'web_hook' }, { useCache: false });
  }

}

module.exports = new RoanuzService(); 