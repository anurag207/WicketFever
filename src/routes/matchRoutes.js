const express = require('express');
const router = express.Router();
const matchController = require('../controllers/matchController');

router.get('/featured', matchController.getFeaturedMatches);
router.get('/live', matchController.getLiveMatches);
router.get('/upcoming', matchController.getUpcomingMatches);
router.get('/completed', matchController.getCompletedMatches);
router.get('/tournament/:tournamentKey', matchController.getMatchesByTournament);

router.get('/upcoming/country/:countryCode', matchController.getUpcomingMatchesForCountry);
router.get('/completed/country/:countryCode', matchController.getCompletedMatchesForCountry);

router.get('/upcoming/team/:teamKey', matchController.getUpcomingMatchesForTeam);
router.get('/completed/team/:teamKey', matchController.getCompletedMatchesForTeam);

router.get('/:matchKey/summary', matchController.getMatchSummary);
router.get('/:matchKey/scorecard-detailed', matchController.getMatchScorecardDetailed);
router.get('/:matchKey/statistics', matchController.getMatchStatistics);
router.get('/:matchKey/ball-by-ball', matchController.getMatchBallByBall);
router.get('/:matchKey/commentary', matchController.getMatchCommentary);
router.get('/:matchKey/best-performances/:type', matchController.getBestPerformances);

router.get('/:matchKey', matchController.getMatchDetails);

module.exports = router; 