/**
 * Redis-based cache service
 * This service uses Redis for caching API responses and other data
 */
const redis = require('redis');
const { REDIS_TTL_SHORT } = require('../config/constants');

class RedisCache {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connect();
  }

  
  async connect() {
    try {
      this.client = redis.createClient({
        url: process.env.REDIS_URL
      });

      // Set up event handlers
      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('ready', () => {
        console.log('Redis client ready');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        console.log('Redis client reconnecting');
      });

      this.client.on('end', () => {
        console.log('Redis client disconnected');
        this.isConnected = false;
      });

      // Connect to Redis
      await this.client.connect();
      console.log('Redis connected successfully');
      this.isConnected = true;
      
      // Start monitoring if in development mode
      if (process.env.NODE_ENV !== 'production') {
        this.startMonitoring();
      }
    } catch (error) {
      console.error('Redis connection error:', error);
      this.isConnected = false;
      
      setTimeout(() => this.connect(), 5000);
    }
  }

  /**
   * Get data from cache
   * @param {string} key - Cache key
   * @returns {Promise<any>} - Cached data or null if not found
   */
  async get(key) {
    try {
      if (!this.isConnected) {
        console.log('Redis not connected, skipping cache get');
        return null;
      }

      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Error getting cached data for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set data in cache
   * @param {string} key - Cache key
   * @param {any} data - Data to cache
   * @param {number} [expiry=REDIS_TTL_SHORT] - Expiry time in seconds
   * @returns {Promise<boolean>} - Success status
   */
  async set(key, data, expiry = REDIS_TTL_SHORT) {
    try {
      if (!this.isConnected) {
        console.log('Redis not connected, skipping cache set');
        return false;
      }

      await this.client.setEx(key, expiry, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error(`Error setting cache for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete data from cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} - Success status
   */
  async delete(key) {
    try {
      if (!this.isConnected) {
        console.log('Redis not connected, skipping cache delete');
        return false;
      }

      await this.client.del(key);
      return true;
    } catch (error) {
      console.error(`Error deleting cache for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Clear all cache (use with caution)
   * @returns {Promise<boolean>} - Success status
   */
  async clear() {
    try {
      if (!this.isConnected) {
        console.log('Redis not connected, skipping cache clear');
        return false;
      }

      await this.client.flushDb();
      return true;
    } catch (error) {
      console.error('Error clearing cache:', error);
      return false;
    }
  }

  /**
   * Fetch data with caching wrapper
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Function to fetch data if not in cache
   * @param {number} [expiry=REDIS_TTL_SHORT] - Expiry time in seconds
   * @returns {Promise<any>} - Data from cache or fetched
   */
  async fetchWithCache(key, fetchFn, expiry = REDIS_TTL_SHORT) {
    try {
      // Try to get from cache first
      const cachedData = await this.get(key);
      if (cachedData) {
        return cachedData;
      }

      // If not in cache, fetch fresh data
      const freshData = await fetchFn();
      
      // Cache the fresh data
      await this.set(key, freshData, expiry);
      
      return freshData;
    } catch (error) {
      console.error(`Error in fetchWithCache for key ${key}:`, error);
      throw error;
    }
  }
  
  /**
   * Get cache statistics
   * @returns {Promise<Object>} - Cache statistics
   */
  async getStats() {
    try {
      if (!this.isConnected) {
        return { connected: false };
      }
      
      const keys = await this.client.keys('*');
      const info = await this.client.info();
      const memory = await this.client.info('memory');
      
      return {
        connected: true,
        keyCount: keys.length,
        keys: keys.slice(0, 20), // Limit to first 20 keys
        memoryUsage: memory,
        info: info
      };
    } catch (error) {
      console.error('Error getting cache stats:', error);
      return { error: error.message };
    }
  }
  
  /**
   * Start monitoring Redis cache
   * Logs cache statistics every minute
   */
  startMonitoring() {
    // Log cache statistics every minute
    setInterval(async () => {
      try {
        if (!this.isConnected) {
          console.log('Redis monitoring: Not connected');
          return;
        }
        
        const keys = await this.client.keys('*');
        console.log(`Redis cache has ${keys.length} keys`);
        
        if (keys.length > 0) {
          // Sample a few keys to check TTL
          const sampleKeys = keys.slice(0, 3);
          for (const key of sampleKeys) {
            const ttl = await this.client.ttl(key);
            console.log(`Key: ${key}, TTL: ${ttl}s`);
          }
        }
      } catch (error) {
        console.error('Redis monitoring error:', error);
      }
    }, 60000); // Every minute
  }
}

module.exports = new RedisCache(); 