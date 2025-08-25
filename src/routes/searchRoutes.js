const express = require('express');
const searchController = require('../controllers/searchController');
const router = express.Router();

/**
 * Universal Search Routes
 * Provides endpoints for searching across all collections
 */

/**
 * @route GET /api/search
 * @desc Universal search across all collections (except ICCRanking)
 * @query {string} q - Search query (minimum 2 characters)
 * @query {number} limit - Maximum number of results (default: 20, max: 100)
 * @example /api/search?q=virat&limit=10
 * @example /api/search?q=australia
 * @example /api/search?q=world%20cup
 */
router.get('/', searchController.universalSearch);

module.exports = router; 