const axios = require('axios');
const { ROANUZ_API_URL, ROANUZ_API_KEY,ROANUZ_PROJ_KEY } = require('../config/constants');

/**
 * Authentication Service for Roanuz API
 * Handles token acquisition, caching, and refreshing
 */
class AuthService {

  
  constructor() {
    this.token = null;
    this.tokenExpiry = null;
    this.tokenValidityPeriod = 23 * 60 * 60 * 1000;
    
    console.log(`AuthService initialized with API URL: ${ROANUZ_API_URL}`);
  }

  /**
   * Get a valid access token
   * @returns {Promise<string>} Access token
   */
  async getToken() {
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      console.log('Using cached Roanuz API token');
      return this.token;
    }

    console.log('Getting new Roanuz API token');
    return this.refreshToken();
  }

  /**
   * Refresh the access token
   * @returns {Promise<string>} New access token
   */
  async refreshToken() {
    try {
      if (!ROANUZ_API_KEY) {
        throw new Error('ROANUZ_API_KEY is not defined');
      }

      const authUrl = `${ROANUZ_API_URL}/core/${ROANUZ_PROJ_KEY}/auth/`;
      console.log(`Making authentication request to: ${authUrl}`);
      
      const response = await axios.post(
        authUrl,
        { api_key: ROANUZ_API_KEY },
        { headers: { 'Content-Type': 'application/json' } }
      );
      // console.log('Response: from auth service', response.data);
      // console.log('Response: from auth service', response.data.data.token);
      if (!response.data || !response.data.data.token) {
        throw new Error('Failed to get token from Roanuz API');
      }

      this.token = response.data.data.token;
      this.tokenExpiry = Date.now() + this.tokenValidityPeriod;

      console.log('Successfully obtained new Roanuz API token');
      return this.token;
    } catch (error) {
      console.error('Error refreshing Roanuz API token:', error.message);
      console.error('API URL:', ROANUZ_API_URL);
      
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', JSON.stringify(error.response.data));
      } else if (error.request) {
        console.error('No response received from authentication request');
      }
      
      throw error;
    }
  }

  /**
   * Force refresh the token regardless of expiry
   * @returns {Promise<string>} New access token
   */
  async forceRefreshToken() {
    this.token = null;
    this.tokenExpiry = null;
    return this.getToken();
  }

  /**
   * Get authorization headers for API requests
   * @returns {Promise<Object>} Headers object with authorization
   */
  async getAuthHeaders() {
    const token = await this.getToken();
    return {
      'Content-Type': 'application/json',
      'rs-token': token
    };
  }
}

module.exports = new AuthService(); 