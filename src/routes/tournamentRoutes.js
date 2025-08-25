const express = require('express');
const router = express.Router();
const tournamentController = require('../controllers/tournamentController');

router.get('/', tournamentController.getAllTournaments);
router.get('/current', tournamentController.getCurrentTournaments);
router.get('/featured', tournamentController.getFeaturedTournaments);
router.get('/associations', tournamentController.getAssociations);
router.get('/association/:associationKey', tournamentController.getAssociationTournaments);

router.get('/upcoming/country/:countryCode', tournamentController.getUpcomingTournamentsForCountry);
router.get('/completed/country/:countryCode', tournamentController.getCompletedTournamentsForCountry);
router.get('/featured/country/:countryCode', tournamentController.getFeaturedTournamentsForCountry);

router.get('/:tournamentKey', tournamentController.getTournamentDetails);
router.get('/:tournamentKey/points-table', tournamentController.getTournamentPointsTable);
router.get('/:tournamentKey/fixtures', tournamentController.getTournamentFixtures);
router.get('/:tournamentKey/matches', tournamentController.getTournamentMatches);
router.get('/:tournamentKey/featured-matches', tournamentController.getTournamentFeaturedMatches);

router.get('/:tournamentKey/team/:teamKey', tournamentController.getTournamentTeamPlayers);

module.exports = router; 