
const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');


router.post('/', profileController.createProfile); // POST /api/profile
router.put('/', profileController.updateProfile);  // PUT  /api/profile
router.get('/:deviceId', profileController.getProfile); // GET /api/profile/:deviceId

module.exports = router;
