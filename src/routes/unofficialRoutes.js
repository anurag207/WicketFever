const express = require('express');
const router = express.Router();
const unofficialController = require('../controllers/unofficialController');

// News endpoints
router.get('/news', unofficialController.getNews);

// Player comparison endpoint
router.get('/players/compare', unofficialController.comparePlayer);

module.exports = router; 