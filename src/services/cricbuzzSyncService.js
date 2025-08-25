const axios = require('axios');
const ICCRanking = require('../models/ICCRanking');
const { RAPID_API_HOST, RAPID_API_KEY, CRICBUZZ_API_URL } = require('../config/constants');

/**
 * Cricbuzz Sync Service
 * Handles syncing ICC rankings from unofficial Cricbuzz API with rate limiting
 */
class CricbuzzSyncService {
  constructor() {
    this.apiClient = null;
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.lastRequestTime = 0;
    this.requestsThisSecond = 0;
    this.currentSecond = Math.floor(Date.now() / 1000);
    
    this.initializeApiClient();
  }

  /**
   * Initialize axios client with RapidAPI headers
   */
  initializeApiClient() {
    if (!RAPID_API_KEY) {
      throw new Error('RAPID_API_KEY is required for ICC rankings sync');
    }

    this.apiClient = axios.create({
      baseURL: CRICBUZZ_API_URL,
      headers: {
        'x-rapidapi-host': RAPID_API_HOST,
        'x-rapidapi-key': RAPID_API_KEY
      }
    });

    console.log('Cricbuzz API client initialized');
  }

     /**
    * Rate limiting: Ensure no more than 5 requests per second
    */
   async rateLimitedRequest(url, isImageRequest = false) {
     return new Promise((resolve, reject) => {
       this.requestQueue.push({ url, resolve, reject, isImageRequest });
       this.processQueue();
     });
   }

  /**
   * Process the request queue with rate limiting
   */
  async processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const currentSecond = Math.floor(Date.now() / 1000);
      
      // Reset counter for new second
      if (currentSecond !== this.currentSecond) {
        this.currentSecond = currentSecond;
        this.requestsThisSecond = 0;
      }

      // If we've hit the limit, wait for next second
      if (this.requestsThisSecond >= 5) {
        const waitTime = 1000 - (Date.now() % 1000) + 10; // Wait till next second + 10ms buffer
        console.log(`Rate limit reached, waiting ${waitTime}ms...`);
        await this.sleep(waitTime);
        continue;
      }

      // Process next request
      const { url, resolve, reject, isImageRequest } = this.requestQueue.shift();
      this.requestsThisSecond++;

      try {
        console.log(`Making request ${this.requestsThisSecond}/5 for URL: ${url}`);
        
        // Configure request for image data
        const config = {
          url,
          method: 'get'
        };
        
        if (isImageRequest) {
          config.responseType = 'arraybuffer';
        }
        
        const response = await this.apiClient(config);
        
        if (isImageRequest) {
          // For image requests, return the buffer data
          resolve(response.data);
        } else {
          // For regular API requests, return JSON data
          resolve(response.data);
        }
      } catch (error) {
        console.error(`Error making request to ${url}:`, error.message);
        reject(error);
      }

      // Small delay between requests to be extra safe
      if (this.requestQueue.length > 0) {
        await this.sleep(50);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get all possible combinations for API calls
   */
  getRankingCombinations() {
    const combinations = [];
    
    // Categories and their applicable formats
    const categoryFormats = {
      'teams': {
        'men': ['test', 'odi', 't20'],
        'women': ['test', 'odi'] // No T20 rankings for women teams
      },
      'batsmen': {
        'men': ['test', 'odi', 't20'],
        'women': ['test', 'odi']
      },
      'bowlers': {
        'men': ['test', 'odi', 't20'],
        'women': ['test', 'odi']
      },
      'all-rounder': {
        'men': ['test', 'odi', 't20'],
        'women': ['test', 'odi']
      }
    };

    Object.entries(categoryFormats).forEach(([category, genderFormats]) => {
      Object.entries(genderFormats).forEach(([gender, formats]) => {
        formats.forEach(format => {
          combinations.push({ category, format, gender });
        });
      });
    });

    return combinations;
  }

  /**
   * Fetch rankings for a specific combination
   */
  async fetchRankings(category, format, gender) {
    const isWomen = gender === 'women' ? 1 : 0;
    const url = `/stats/get-icc-rankings?category=${category}&formatType=${format}&isWomen=${isWomen}`;
    
    try {
      const data = await this.rateLimitedRequest(url);
      return this.transformRankingsData(data, category, format, gender);
    } catch (error) {
      console.error(`Failed to fetch ${category} ${format} ${gender} rankings:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch image from Cricbuzz API and convert to base64
   */
  async fetchImageAsBase64(imageId) {
    if (!imageId) {
      return null;
    }

    try {
      const url = `/get-image?id=${imageId}`;
      console.log(`Fetching image: ${imageId}`);
      
      const arrayBuffer = await this.rateLimitedRequest(url, true);
      
      if (arrayBuffer && arrayBuffer.byteLength > 0) {
        // Convert ArrayBuffer to base64
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return `data:image/jpeg;base64,${base64}`;
      }
      
      console.warn(`Invalid or empty image response for ID ${imageId}`);
      return null;
    } catch (error) {
      console.error(`Failed to fetch image ${imageId}:`, error.message);
      return null;
    }
  }

  /**
   * Fetch images for all rankings with rate limiting
   */
  async fetchImagesForRankings(rankings) {
    console.log('Fetching images for rankings...');
    
    // Collect all unique image IDs
    const imageIds = new Set();
    rankings.forEach(ranking => {
      if (ranking.imageId) imageIds.add(ranking.imageId);
      if (ranking.faceImageId) imageIds.add(ranking.faceImageId);
    });

    const uniqueImageIds = Array.from(imageIds);
    console.log(`Found ${uniqueImageIds.length} unique images to fetch`);

    // Fetch all images and create a map
    const imageMap = new Map();
    let successCount = 0;
    let failCount = 0;

    for (const imageId of uniqueImageIds) {
      try {
        const base64Image = await this.fetchImageAsBase64(imageId);
        if (base64Image) {
          imageMap.set(imageId, base64Image);
          successCount++;
          console.log(`✓ Image ${imageId} fetched successfully (${successCount}/${uniqueImageIds.length})`);
        } else {
          failCount++;
          console.log(`✗ Image ${imageId} failed (${failCount} failures so far)`);
        }
      } catch (error) {
        failCount++;
        console.error(`✗ Image ${imageId} error:`, error.message);
      }
    }

    console.log(`Image fetch completed: ${successCount} success, ${failCount} failed`);

    // Update rankings with their corresponding images
    return rankings.map(ranking => {
      const imageId = ranking.imageId || ranking.faceImageId;
      const displayImg = imageId ? imageMap.get(imageId) : null;
      
      return {
        ...ranking,
        displayImg
      };
    });
  }

  /**
   * Transform API response to our model format
   */
  transformRankingsData(apiData, category, format, gender) {
    if (!apiData || !apiData.rank || !Array.isArray(apiData.rank)) {
      console.warn(`Invalid data structure for ${category} ${format} ${gender}`);
      return [];
    }

    return apiData.rank.map(item => {
      const baseData = {
        category,
        format,
        gender,
        rank: parseInt(item.rank),
        name: item.name,
        rating: item.rating || '0',
        points: item.points || '0',
        lastUpdatedOn: item.lastUpdatedOn || new Date().toISOString().split('T')[0]
      };

      // Add category-specific fields
      if (category === 'teams') {
        return {
          ...baseData,
          teamId: item.id || null,
          matches: item.matches || null,
          imageId: item.imageId || null
        };
      } else {
        // Player categories
        return {
          ...baseData,
          playerId: item.id || null,
          country: item.country || null,
          trend: item.trend || null,
          faceImageId: item.faceImageId || null
        };
      }
    });
  }

  /**
   * Sync all ICC rankings
   */
  async syncAllRankings() {
    const syncBatch = `sync_${Date.now()}`;
    console.log(`Starting ICC rankings sync: ${syncBatch}`);
    
    try {
      const combinations = this.getRankingCombinations();
      const allRankings = [];
      
      console.log(`Fetching ${combinations.length} ranking combinations...`);
      
      for (const { category, format, gender } of combinations) {
        try {
          console.log(`Fetching ${category} ${format} ${gender} rankings...`);
          const rankings = await this.fetchRankings(category, format, gender);
          allRankings.push(...rankings);
          console.log(`✓ Fetched ${rankings.length} ${category} ${format} ${gender} rankings`);
        } catch (error) {
          console.error(`✗ Failed to fetch ${category} ${format} ${gender} rankings:`, error.message);
          // Continue with other combinations even if one fails
        }
      }

      if (allRankings.length === 0) {
        throw new Error('No rankings data was successfully fetched');
      }

      // Fetch images for all rankings
      console.log(`Fetching images for ${allRankings.length} rankings...`);
      const rankingsWithImages = await this.fetchImagesForRankings(allRankings);

      // Replace all rankings in database
      console.log(`Replacing database with ${rankingsWithImages.length} total rankings (with images)...`);
      await ICCRanking.replaceRankings(rankingsWithImages, syncBatch);
      
      console.log(`✓ ICC rankings sync completed successfully: ${syncBatch}`);
      return {
        success: true,
        syncBatch,
        totalRankings: rankingsWithImages.length,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('ICC rankings sync failed:', error.message);
      throw error;
    }
  }

  /**
   * Get sync status
   */
  async getSyncStatus() {
    try {
      const latestSync = await ICCRanking.getLatestSyncInfo();
      const totalRankings = await ICCRanking.countDocuments();
      
      return {
        hasData: totalRankings > 0,
        totalRankings,
        lastSync: latestSync ? {
          batch: latestSync.syncBatch,
          timestamp: latestSync.createdAt
        } : null
      };
    } catch (error) {
      console.error('Error getting sync status:', error.message);
      return {
        hasData: false,
        totalRankings: 0,
        lastSync: null,
        error: error.message
      };
    }
  }

  /**
   * Check if initial sync is needed
   */
  async isInitialSyncNeeded() {
    const status = await this.getSyncStatus();
    return !status.hasData;
  }
}

module.exports = new CricbuzzSyncService(); 