const axios = require('axios');
const { RAPID_API_HOST, RAPID_API_KEY, CRICBUZZ_API_URL } = require('../config/constants');

class UnofficialCricbuzzService {
  constructor() {
    this.requestQueue = [];
    this.isProcessingQueue = false;
    this.requestsThisSecond = 0;
    this.currentSecond = 0;
    this.initializeApiClient();
  }

  /**
   * Initialize API client with RapidAPI credentials
   */
  initializeApiClient() {
    this.apiClient = axios.create({
      baseURL: CRICBUZZ_API_URL,
      headers: {
        'x-rapidapi-host': RAPID_API_HOST,
        'x-rapidapi-key': RAPID_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    console.log('Unofficial Cricbuzz API client initialized');
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
   * Fetch news from unofficial cricbuzz API
   */
  async fetchNews() {
    try {
      const url = '/news/list';
      console.log('Fetching news from unofficial API...');
      
      const data = await this.rateLimitedRequest(url);
      return data;
    } catch (error) {
      console.error('Failed to fetch news:', error.message);
      throw error;
    }
  }

  /**
   * Fetch news with images processed to base64
   */
  async fetchNewsWithImages() {
    try {
      // Fetch news data
      const newsData = await this.fetchNews();
      
      if (!newsData || !newsData.newsList) {
        throw new Error('Invalid news data structure');
      }

      console.log(`Processing ${newsData.newsList.length} news items...`);

      // Process each news item to fetch images
      const processedNewsList = [];
      
      for (const item of newsData.newsList) {
        // Skip ads
        if (item.ad) {
          processedNewsList.push(item);
          continue;
        }

        if (item.story) {
          const story = { ...item.story };
          
          // Fetch cover image if available
          if (story.imageId) {
            console.log(`Fetching cover image for story ${story.id}...`);
            const base64Image = await this.fetchImageAsBase64(story.imageId);
            if (base64Image) {
              story.coverImageBase64 = base64Image;
              console.log(`✓ Cover image fetched for story ${story.id}`);
            } else {
              console.log(`✗ Failed to fetch cover image for story ${story.id}`);
            }
          }

          processedNewsList.push({ story });
        } else {
          // Handle any other item types
          processedNewsList.push(item);
        }
      }

      return {
        ...newsData,
        newsList: processedNewsList
      };

    } catch (error) {
      console.error('Failed to fetch news with images:', error.message);
      throw error;
    }
  }

  /**
   * Fetch player information from unofficial cricbuzz API
   */
  async fetchPlayerInfo(playerId) {
    try {
      const url = `/players/get-info?playerId=${playerId}`;
      console.log(`Fetching player info for ID: ${playerId}`);
      
      const data = await this.rateLimitedRequest(url);
      return data;
    } catch (error) {
      console.error(`Failed to fetch player info for ${playerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Transform player data for comparison
   */
  transformPlayerForComparison(playerData) {
    if (!playerData) {
      return null;
    }

    // Extract batting hand
    let battingHand = 'Unknown';
    if (playerData.bat) {
      if (playerData.bat.toLowerCase().includes('left')) {
        battingHand = 'Left Hand';
      } else if (playerData.bat.toLowerCase().includes('right')) {
        battingHand = 'Right Hand';
      }
    }

    // Extract bowling style
    let bowlingStyle = 'Unknown';
    if (playerData.bowl) {
      // Transform "Right-arm offbreak" to "Right - Arm Off Spin" format
      let bowl = playerData.bowl;
      if (bowl.toLowerCase().includes('right-arm')) {
        if (bowl.toLowerCase().includes('offbreak') || bowl.toLowerCase().includes('off')) {
          bowlingStyle = 'Right - Arm Off Spin';
        } else if (bowl.toLowerCase().includes('leg') || bowl.toLowerCase().includes('googly')) {
          bowlingStyle = 'Right - Arm Leg Spin';
        } else if (bowl.toLowerCase().includes('fast') || bowl.toLowerCase().includes('medium')) {
          bowlingStyle = 'Right - Arm Fast';
        } else {
          bowlingStyle = 'Right - Arm';
        }
      } else if (bowl.toLowerCase().includes('left-arm')) {
        if (bowl.toLowerCase().includes('orthodox') || bowl.toLowerCase().includes('slow')) {
          bowlingStyle = 'Left - Arm Orthodox';
        } else if (bowl.toLowerCase().includes('fast') || bowl.toLowerCase().includes('medium')) {
          bowlingStyle = 'Left - Arm Fast';
        } else {
          bowlingStyle = 'Left - Arm';
        }
      }
    }

    return {
      id: playerData.id,
      name: playerData.name || 'Unknown',
      dateOfBirth: playerData.DoBFormat || playerData.DoB || 'Unknown',
      role: playerData.role || 'Unknown',
      battingHand,
      bowlingStyle,
      faceImageId: playerData.faceImageId || null
    };
  }

  /**
   * Fetch player with image and caching
   */
  async fetchPlayerWithImageCached(playerId, cacheService) {
    const cacheKey = `unofficial:player:${playerId}`;
    
    // Try cache first
    let playerData = await cacheService.get(cacheKey);
    
    if (!playerData) {
      console.log(`Fetching fresh player data for ID: ${playerId}`);
      
      // Fetch player data
      const rawPlayerData = await this.fetchPlayerInfo(playerId);
      const transformedPlayer = this.transformPlayerForComparison(rawPlayerData);
      
      if (!transformedPlayer) {
        throw new Error(`Failed to transform player data for ${playerId}`);
      }

      // Fetch player image
      let playerImage = null;
      if (transformedPlayer.faceImageId) {
        console.log(`Fetching image for player ${playerId}...`);
        playerImage = await this.fetchImageAsBase64(transformedPlayer.faceImageId);
        if (playerImage) {
          console.log(`✓ Player ${playerId} image fetched successfully`);
        } else {
          console.log(`✗ Failed to fetch player ${playerId} image`);
        }
      }

      // Add image to player data
      if (playerImage) {
        transformedPlayer.playerImageBase64 = playerImage;
      }

      playerData = transformedPlayer;
      
      // Cache the player data
      await cacheService.set(cacheKey, playerData, require('../config/constants').REDIS_TTL_MEDIUM);
      console.log(`✓ Player ${playerId} data cached`);
    } else {
      console.log(`✓ Player ${playerId} data retrieved from cache`);
    }
    
    return playerData;
  }

  /**
   * Compare two players with images
   */
  async comparePlayersWithImages(player1Id, player2Id, cacheService) {
    try {
      console.log(`Comparing players: ${player1Id} vs ${player2Id}`);

      // Fetch both players' data with individual caching
      const [player1, player2] = await Promise.all([
        this.fetchPlayerWithImageCached(player1Id, cacheService),
        this.fetchPlayerWithImageCached(player2Id, cacheService)
      ]);

      if (!player1 || !player2) {
        throw new Error('Failed to fetch player data');
      }

      return {
        player1,
        player2,
        comparisonFields: [
          'dateOfBirth',
          'role',
          'battingHand',
          'bowlingStyle'
        ]
      };

    } catch (error) {
      console.error('Failed to compare players with images:', error.message);
      throw error;
    }
  }
}

module.exports = new UnofficialCricbuzzService(); 