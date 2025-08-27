const cacheService = require('../services/cacheService');
const { REDIS_TTL_MEDIUM } = require('../config/constants');
const unofficialCricbuzzService = require('../services/unofficialCricbuzzService');
const roanuzService = require('../services/roanuzService');


class NewsController {
  /**
 * Get cricket news (from Roanuz News Aggregator)
 * - Deduplicate identical items
 * - Fallback: description_text <- description
 * - Cache processed response in Redis (medium TTL)
 * @param {object} req
 * @param {object} res
 */
 async getNews (req, res) {
  try {
    const cacheKey = 'news:list';

    // Check Redis cache first
    const cachedData = await cacheService.get(cacheKey);
    if (cachedData) {
      console.log('Returning news from Redis cache');
      return res.json(cachedData);
    }

    // Fetch fresh from Roanuz (service already handles API caching if enabled)
    console.log('Fetching fresh news data from Roanuz News Aggregator API');
    const apiResponse = await roanuzService.getNews({
      useCache: true,
      cacheTTL: REDIS_TTL_MEDIUM
    });

    // Raw list from aggregator
    const rawNews = apiResponse?.data?.news || [];

    // Remove duplicates from api response
    const seen = new Set();
    const processedNews = [];

    for (const item of rawNews) {
      if (!item) continue;

      // Prefer link as unique id; fallback to (title|provider|updated)
      const dedupeKey =
        item.link ||
        `${(item.title || '').trim()}|${item?.provider?.url || item?.provider?.name || ''}|${item.updated || ''}`;

      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      processedNews.push({
        ...item,
        // Fallback for description_text
        description_text:
          (item.description_text && item.description_text.trim()) ||
          (item.description && item.description.trim()) ||
          null
      });
    }

    const response = {
      data: {
        news: processedNews
      }
    };

    // Cache processed response
    await cacheService.set(cacheKey, response, REDIS_TTL_MEDIUM);
    console.log(`✓ News data cached for ${REDIS_TTL_MEDIUM} seconds`);

    return res.json(response);
  } catch (error) {
    console.error('Error fetching news:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch news',
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
    });
  }
};

  
}

module.exports = new NewsController(); 