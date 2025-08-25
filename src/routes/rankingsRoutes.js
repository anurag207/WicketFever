const express = require('express');
const rankingsController = require('../controllers/rankingsController');
const router = express.Router();

/**
 * ICC Rankings Routes
 * Provides endpoints for team and player rankings
 */

/**
 * @route GET /api/rankings/teams
 * @desc Get team rankings
 * @query {string} format - Format type (test, odi, t20)
 * @query {string} gender - Gender (men, women)
 * @example /api/rankings/teams?format=test&gender=men
 */
router.get('/teams', rankingsController.getTeamRankings);

/**
 * @route GET /api/rankings/players
 * @desc Get player rankings
 * @query {string} category - Player category (batsmen, bowlers, all-rounder)
 * @query {string} format - Format type (test, odi, t20)
 * @query {string} gender - Gender (men, women)
 * @example /api/rankings/players?category=batsmen&format=odi&gender=men
 */
router.get('/players', rankingsController.getPlayerRankings);

/**
 * @route GET /api/rankings/filters
 * @desc Get available filter options
 * @returns Available categories, formats, and gender options
 */
router.get('/filters', rankingsController.getAvailableFilters);

/**
 * @route GET /api/rankings/sync-status
 * @desc Get synchronization status
 * @returns Information about last sync and data availability
 */
router.get('/sync-status', rankingsController.getSyncStatus);

/**
 * @route GET /api/rankings/summary
 * @desc Get rankings summary for monitoring
 * @returns Summary of all rankings data
 */
router.get('/summary', rankingsController.getRankingsSummary);

/**
 * @route POST /api/rankings/force-sync
 * @desc Force manual synchronization of rankings
 * @access Admin only (in production, add authentication middleware)
 */
router.post('/force-sync', rankingsController.forceSyncRankings);

module.exports = router; 