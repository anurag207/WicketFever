const express = require('express');
const router = express.Router();
const newsController = require('../controllers/newsController');

// News endpoints
router.get('/', newsController.getNews);


module.exports = router; 