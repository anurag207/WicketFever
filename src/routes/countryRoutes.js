const express = require('express');
const router = express.Router();
const countryController = require('../controllers/countryController');

router.get('/', countryController.getAllCountries);
router.post('/sync', countryController.syncCountriesFromRoanuz);
router.get('/:countryCode/flag', countryController.getCountryFlag);
router.put('/:countryCode', countryController.updateCountry);

module.exports = router; 