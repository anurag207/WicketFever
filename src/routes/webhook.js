// routes/webhooks.js
const express = require('express');
const zlib = require('zlib');
const Match = require('../models/Match');
const cacheService = require('../services/cacheService');
const socketScorecardService = require('../services/socketScorecardService');
const { REDIS_TTL_LIVE } = require('../config/constants');

const router = express.Router();

// Middleware to get raw body for webhook processing
function rawBody(req, res, next) {
  req.rawBody = '';
  req.setEncoding('utf8');
  req.on('data', function(chunk) {
    req.rawBody += chunk;
  });
  req.on('end', function() {
    next();
  });
}

router.use(rawBody);

// Webhook endpoint for Roanuz match updates
router.post('/roanuz/match/feed/v1', async (req, res) => {
  try {
    // Verify API key (if configured)
    const API_KEY = process.env.ROANUZ_API_KEY;
    if (API_KEY && req.headers['rs-api-key'] !== API_KEY) {
      console.log('Webhook authentication failed');
      return res.status(401).json({ status: false, error: 'Authentication failed' });
    }

    // Decompress the data if it's gzipped
    let data;
    if (req.headers['content-encoding'] === 'gzip') {
      try {
        const buffer = Buffer.from(req.rawBody, 'base64');
        data = await new Promise((resolve, reject) => {
          zlib.gunzip(buffer, (err, result) => {
            if (err) reject(err);
            else resolve(JSON.parse(result.toString()));
          });
        });
      } catch (decompressError) {
        console.error('Error decompressing webhook data:', decompressError);
        return res.status(400).json({ status: false, error: 'Invalid compressed data' });
      }
    } else {
      // If not compressed, parse as JSON directly
      try {
        data = JSON.parse(req.rawBody);
      } catch (parseError) {
        console.error('Error parsing webhook data:', parseError);
        return res.status(400).json({ status: false, error: 'Invalid JSON data' });
      }
    }

    console.log('📨 Received webhook update for match:', data.match_key);

    // Process the webhook data
    await processWebhookData(data);

    res.json({ status: true, message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ status: false, error: 'Internal server error' });
  }
});

// Process webhook data (similar to pollMatchDetailedScorecard)
async function processWebhookData(webhookData) {
  const matchKey = webhookData.match_key;
  
  try {
    // Build detailed scorecard using the same logic as before
    const detailedScorecard = buildDetailedScorecard(webhookData);
    
    // Update Redis caches
    await Promise.all([
      // Match details
      cacheService.set(`match:${matchKey}`, webhookData, REDIS_TTL_LIVE),
      
      // Detailed scorecard - key that frontend will read
      cacheService.set(`scorecard-detailed:${matchKey}`, { data: detailedScorecard }, REDIS_TTL_LIVE)
    ]);

    // Push updates via socket
    socketScorecardService.pushScorecardUpdate(matchKey, detailedScorecard);
    
    // Update MongoDB backup
    await Match.findOneAndUpdate(
      { key: matchKey },
      { 
        ...webhookData,
        detailed_scorecard: detailedScorecard,
        last_updated: new Date(),
        raw_data: webhookData
      },
      { upsert: true }
    );
    
    console.log(`✅ Updated detailed scorecard via webhook for ${matchKey}`);
  } catch (error) {
    console.error(`❌ Error processing webhook for ${matchKey}:`, error);
  }
}

// Reuse the buildDetailedScorecard function from LiveMatchesPoller
function buildDetailedScorecard(matchData) {
  // Your existing implementation from LiveMatchesPoller
  // ... (copy the exact same function here)
}

module.exports = router;