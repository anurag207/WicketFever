const ICCRanking = require('../models/ICCRanking');
const cricbuzzSyncService = require('../services/cricbuzzSyncService');
const cacheService = require('../services/cacheService');
const { REDIS_TTL_RANKINGS } = require('../config/constants');

/**
 * ICC Rankings Controller
 * Handles all ICC rankings related API endpoints
 */
class RankingsController {

  /**
   * Get team rankings
   * GET /api/rankings/teams?format=test&gender=men
   */
  async getTeamRankings(req, res) {
    try {
      const { format = 'test', gender = 'men' } = req.query;
      
      // Validate parameters
      if (!['test', 'odi', 't20'].includes(format)) {
        return res.status(400).json({ 
          message: 'Invalid format. Must be one of: test, odi, t20' 
        });
      }
      
      if (!['men', 'women'].includes(gender)) {
        return res.status(400).json({ 
          message: 'Invalid gender. Must be one of: men, women' 
        });
      }

      // Women don't have T20 team rankings
      if (gender === 'women' && format === 't20') {
        return res.status(400).json({ 
          message: 'T20 team rankings are not available for women' 
        });
      }

      const cacheKey = `rankings:teams:${format}:${gender}`;
      
      // Try cache first
      let rankings = await cacheService.get(cacheKey);
      
      if (!rankings) {
        // Fetch from database
        rankings = await ICCRanking.getRankings({
          category: 'teams',
          format,
          gender
        });
        
        // Cache the results
        if (rankings.length > 0) {
          await cacheService.set(cacheKey, rankings, REDIS_TTL_RANKINGS);
        }
      }

      res.json({
        success: true,
        data: {
          category: 'teams',
          format,
          gender,
          rankings: rankings || [],
          total: rankings ? rankings.length : 0
        }
      });
    } catch (error) {
      console.error('Error fetching team rankings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch team rankings',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }

  /**
   * Get player rankings (batsmen, bowlers, all-rounder)
   * GET /api/rankings/players?category=batsmen&format=odi&gender=men
   */
  async getPlayerRankings(req, res) {
    try {
      const { category = 'batsmen', format = 'test', gender = 'men' } = req.query;
      
      // Validate parameters
      if (!['batsmen', 'bowlers', 'all-rounder'].includes(category)) {
        return res.status(400).json({ 
          message: 'Invalid category. Must be one of: batsmen, bowlers, all-rounder' 
        });
      }
      
      if (!['test', 'odi', 't20'].includes(format)) {
        return res.status(400).json({ 
          message: 'Invalid format. Must be one of: test, odi, t20' 
        });
      }
      
      if (!['men', 'women'].includes(gender)) {
        return res.status(400).json({ 
          message: 'Invalid gender. Must be one of: men, women' 
        });
      }

      // Women don't have T20 rankings
      if (gender === 'women' && format === 't20') {
        return res.status(400).json({ 
          message: 'T20 player rankings are not available for women' 
        });
      }

      const cacheKey = `rankings:players:${category}:${format}:${gender}`;
      
      // Try cache first
      let rankings = await cacheService.get(cacheKey);
      
      if (!rankings) {
        // Fetch from database
        rankings = await ICCRanking.getRankings({
          category,
          format,
          gender
        });
        
        // Cache the results
        if (rankings.length > 0) {
          await cacheService.set(cacheKey, rankings, REDIS_TTL_RANKINGS);
        }
      }

      res.json({
        success: true,
        data: {
          category,
          format,
          gender,
          rankings: rankings || [],
          total: rankings ? rankings.length : 0
        }
      });
    } catch (error) {
      console.error('Error fetching player rankings:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch player rankings',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }

  /**
   * Get available filters/options
   * GET /api/rankings/filters
   */
  async getAvailableFilters(req, res) {
    try {
      const filters = {
        categories: {
          teams: {
            name: 'Teams',
            formats: {
              men: ['test', 'odi', 't20'],
              women: ['test', 'odi']
            }
          },
          players: {
            name: 'Players',
            subcategories: {
              batsmen: {
                name: 'Batting',
                formats: {
                  men: ['test', 'odi', 't20'],
                  women: ['test', 'odi']
                }
              },
              bowlers: {
                name: 'Bowling',
                formats: {
                  men: ['test', 'odi', 't20'],
                  women: ['test', 'odi']
                }
              },
              'all-rounder': {
                name: 'All Rounder',
                formats: {
                  men: ['test', 'odi', 't20'],
                  women: ['test', 'odi']
                }
              }
            }
          }
        },
        formats: [
          { key: 'test', name: 'Test' },
          { key: 'odi', name: 'ODI' },
          { key: 't20', name: 'T20' }
        ],
        genders: [
          { key: 'men', name: "Men's" },
          { key: 'women', name: "Women's" }
        ]
      };

      res.json({
        success: true,
        data: filters
      });
    } catch (error) {
      console.error('Error fetching filters:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch filters',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }

  /**
   * Get sync status
   * GET /api/rankings/sync-status
   */
  async getSyncStatus(req, res) {
    try {
      const status = await cricbuzzSyncService.getSyncStatus();
      
      res.json({
        success: true,
        data: status
      });
    } catch (error) {
      console.error('Error fetching sync status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch sync status',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }

  /**
   * Force sync rankings (admin only)
   * POST /api/rankings/force-sync
   */
  async forceSyncRankings(req, res) {
    try {
      console.log('Manual sync triggered');
      
      // Clear all rankings cache
      await this.clearRankingsCache();
      
      // Perform sync
      const result = await cricbuzzSyncService.syncAllRankings();
      
      res.json({
        success: true,
        message: 'Rankings sync completed successfully',
        data: result
      });
    } catch (error) {
      console.error('Error during manual sync:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to sync rankings',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }

  /**
   * Clear rankings cache
   */
  async clearRankingsCache() {
    try {
      // Define all possible cache keys
      const categories = ['teams', 'batsmen', 'bowlers', 'all-rounder'];
      const formats = ['test', 'odi', 't20'];
      const genders = ['men', 'women'];
      
      const cacheKeys = [];
      
      categories.forEach(category => {
        formats.forEach(format => {
          genders.forEach(gender => {
            if (category === 'teams') {
              cacheKeys.push(`rankings:teams:${format}:${gender}`);
            } else {
              cacheKeys.push(`rankings:players:${category}:${format}:${gender}`);
            }
          });
        });
      });
      
      // Delete all cache keys
      for (const key of cacheKeys) {
        await cacheService.delete(key);
      }
      
      console.log('Rankings cache cleared');
    } catch (error) {
      console.error('Error clearing rankings cache:', error);
    }
  }

  /**
   * Get rankings summary (for dashboard/monitoring)
   * GET /api/rankings/summary
   */
  async getRankingsSummary(req, res) {
    try {
      const summary = {};
      
      // Get counts for each category/format/gender combination
      const categories = ['teams', 'batsmen', 'bowlers', 'all-rounder'];
      const formats = ['test', 'odi', 't20'];
      const genders = ['men', 'women'];
      
      for (const category of categories) {
        summary[category] = {};
        for (const format of formats) {
          summary[category][format] = {};
          for (const gender of genders) {
            // Skip invalid combinations
            if (gender === 'women' && format === 't20') {
              continue;
            }
            
            const count = await ICCRanking.countDocuments({
              category,
              format,
              gender
            });
            
            summary[category][format][gender] = count;
          }
        }
      }
      
      const totalRankings = await ICCRanking.countDocuments();
      const syncStatus = await cricbuzzSyncService.getSyncStatus();
      
      res.json({
        success: true,
        data: {
          summary,
          totalRankings,
          syncStatus
        }
      });
    } catch (error) {
      console.error('Error fetching rankings summary:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch rankings summary',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message
      });
    }
  }
}

module.exports = new RankingsController(); 