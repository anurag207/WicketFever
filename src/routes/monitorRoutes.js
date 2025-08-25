const express = require('express');
const router = express.Router();
const monitorController = require('../controllers/monitorController');

router.get('/cache', monitorController.getCacheStats);
router.post('/cache/clear', monitorController.clearCache);

module.exports = router; 