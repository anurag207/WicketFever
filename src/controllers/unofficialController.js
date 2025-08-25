const cacheService = require('../services/cacheService');
const { REDIS_TTL_MEDIUM } = require('../config/constants');
const unofficialCricbuzzService = require('../services/unofficialCricbuzzService');

class UnofficialController {

  /**
   * Get cricket news with images
   * GET /api/unofficial/news
   */
  async getNews(req, res) {
    try {
      const cacheKey = 'unofficial:news:list';
      
      // Try cache first
      let newsData = await cacheService.get(cacheKey);
      
      if (!newsData) {
        console.log('Fetching fresh news data from unofficial API...');
        
        // Fetch fresh news data
        newsData = await unofficialCricbuzzService.fetchNewsWithImages();
        
        // Cache the results
        if (newsData && newsData.newsList) {
          await cacheService.set(cacheKey, newsData, REDIS_TTL_MEDIUM);
          console.log(`✓ News data cached for ${REDIS_TTL_MEDIUM} seconds`);
        }
      } else {
        console.log('✓ News data retrieved from cache');
      }

      res.json({
        success: true,
        data: newsData,
        cached: !!newsData
      });

    } catch (error) {
      console.error('Error fetching news:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch news',
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
      });
    }
  }

  /**
   * Compare two players
   * GET /api/unofficial/players/compare?player1Id=6635&player2Id=1234
   */
  async comparePlayer(req, res) {
    try {
      const { player1Id, player2Id } = req.query;

      // Validate parameters
      if (!player1Id || !player2Id) {
        return res.status(400).json({
          success: false,
          message: 'Both player1Id and player2Id are required'
        });
      }

      console.log(`Fetching player comparison data for ${player1Id} vs ${player2Id}...`);
      
      // Fetch comparison data with individual player caching
      const comparisonData = await unofficialCricbuzzService.comparePlayersWithImages(player1Id, player2Id, cacheService);

      res.json({
        success: true,
        data: comparisonData
      });

    } catch (error) {
      console.error('Error fetching player comparison:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch player comparison',
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
      });
    }
  }
}

module.exports = new UnofficialController(); 