const express = require('express');
const zlib = require('zlib');
const Match = require('../models/Match');
const cacheService = require('../services/cacheService');
const socketScorecardService = require('../services/socketScorecardService');
const { REDIS_TTL_LIVE, ROANUZ_WEBHOOK_API_KEY } = require('../config/constants');

const router = express.Router();

/**
 * ✅ IMPORTANT: Read raw Buffer so we can unzip compressed payloads.
 * Keep this router mounted BEFORE global express.json()
 */
router.use(express.raw({ type: '*/*', limit: '5mb' }));

// ✅ Correct path: final URL = /webhooks/roanuz/match/feed/v1
router.post('/roanuz/match/feed/v1', async (req, res) => {
  try {
    // ✅ Verify webhook secret from Roanuz console (don't use rs-token)
    const headerKey = req.headers['rs-api-key'];
    if (ROANUZ_WEBHOOK_API_KEY && headerKey !== ROANUZ_WEBHOOK_API_KEY) {
      console.log('❌ Webhook auth failed');
      return res.status(401).json({ status: false, error: 'Authentication failed' });
    }

    // ✅ Unzip the compressed body (Buffer). Works for gzip/deflate.
    const zipped = req.body; // Buffer from express.raw
    zlib.unzip(zipped, async (err, buffer) => {
      if (err) {
        console.error('❌ unzip error:', err.message);
        return res.status(400).json({ status: false, error: 'Invalid compressed data' });
      }

      let payload;
      try {
        payload = JSON.parse(buffer.toString());
      } catch (e) {
        console.error('❌ JSON parse error:', e.message);
        return res.status(400).json({ status: false, error: 'Invalid JSON' });
      }

      /**
       * Roanuz payload shape can be either:
       *  - { data: { key: '...', ... } }
       *  - { key: '...', ... }
       */
      const matchData = payload?.data?.key ? payload.data : payload;
      const matchKey = matchData?.key || matchData?.match_key;

      if (!matchKey) {
        console.warn('⚠️ Webhook payload missing match key');
        return res.json({ status: true });
      }

      console.log('📨 Webhook update for match:', matchKey);

      // Process & persist
      await processWebhookData(matchData);

      return res.json({ status: true, message: 'Webhook processed successfully' });
    });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ status: false, error: 'Internal server error' });
  }
});

// Process webhook data 
async function processWebhookData(matchData) {
  const matchKey = matchData.key || matchData.match_key;

  try {
    const detailedScorecard = buildDetailedScorecard(matchData);

 
    await Promise.all([
      cacheService.set(`match:${matchKey}`, { data: matchData }, REDIS_TTL_LIVE),
      cacheService.set(`scorecard-detailed:${matchKey}`, { data: detailedScorecard }, REDIS_TTL_LIVE),
    ]);

    // Push to FE
    try {
      socketScorecardService.pushScorecardUpdate(matchKey, detailedScorecard);
    } catch (e) {
      console.error('Socket push failed:', e.message);
    }

    // Mongo backup
    try {
      await Match.findOneAndUpdate(
        { key: matchKey },
        {
          ...matchData,
          detailed_scorecard: detailedScorecard,
          last_updated: new Date(),
          raw_data: matchData,
        },
        { upsert: true }
      );
    } catch (e) {
      console.error('Mongo upsert failed:', e.message);
    }

    console.log(`✅ Updated detailed scorecard via webhook for ${matchKey}`);
  } catch (error) {
    console.error(`❌ Error processing webhook for ${matchKey}:`, error);
  }
}


function buildDetailedScorecard(matchData) {
  try {
    // Get innings data
    const innings = matchData.play?.innings || {};
    const inningsOrder = matchData.play?.innings_order || Object.keys(innings);
    
    // Process each innings for the response
    const processedInnings = [];
    
    for (const inningsKey of inningsOrder) {
      const inning = innings[inningsKey];
      if (!inning) continue;
      
      const teamKey = inningsKey.split('_')[0]; // 'a' or 'b'
      const opposingTeamKey = teamKey === 'a' ? 'b' : 'a';
      
      // Format batting data
      const battingData = [];
      
      // Try to get batting data from inning structure first
      if (inning.batting_players && Object.keys(inning.batting_players).length > 0) {
        // Use actual batting data from innings
        for (const playerKey in inning.batting_players) {
          const player = inning.batting_players[playerKey];
          battingData.push({
            name: player.name || playerKey,
            dismissal: player.how_out || 'not out',
            runs: player.runs || 0,
            balls: player.balls || 0,
            fours: player.fours || 0,
            sixes: player.sixes || 0,
            strike_rate: player.strike_rate?.toFixed(2) || '0.00'
          });
        }
      } else {
        // Fallback to old structure if available
        const teamPlayers = matchData.players || {};
        
        // Process batting order players
        if (inning.batting_order && Array.isArray(inning.batting_order)) {
          for (const playerKey of inning.batting_order) {
            if (teamPlayers[playerKey] && teamPlayers[playerKey].score) {
              const playerInfo = teamPlayers[playerKey].player;
              const playerScore = teamPlayers[playerKey].score['1']?.batting?.score || {};
              const dismissalInfo = teamPlayers[playerKey].score['1']?.batting?.dismissal || null;
              
              let dismissalText = 'not out';
              if (dismissalInfo) {
                dismissalText = dismissalInfo.msg || 'out';
              }
              
              battingData.push({
                name: playerInfo.name,
                dismissal: dismissalText,
                runs: playerScore.runs || 0,
                balls: playerScore.balls || 0,
                fours: playerScore.fours || 0,
                sixes: playerScore.sixes || 0,
                strike_rate: playerScore.strike_rate?.toFixed(2) || '0.00'
              });
            }
          }
        }
      }
      
      // Format bowling data
      const bowlingData = [];
      
      // Try to get bowling data from inning structure first
      if (inning.bowling_players && Object.keys(inning.bowling_players).length > 0) {
        // Use actual bowling data from innings
        for (const playerKey in inning.bowling_players) {
          const player = inning.bowling_players[playerKey];
          if (parseFloat(player.overs) > 0 || player.wickets > 0) {
            bowlingData.push({
              name: player.name || playerKey,
              overs: parseFloat(player.overs || 0).toFixed(1),
              maidens: player.maidens || 0,
              runs: player.runs || 0,
              wickets: player.wickets || 0,
              economy: player.economy?.toFixed(2) || '0.00'
            });
          }
        }
      } else {
        // Fallback to old structure if available
        const teamPlayers = matchData.players || {};
        
        // Get all players from opposing team who bowled in this innings
        for (const playerKey in teamPlayers) {
          const playerScore = teamPlayers[playerKey].score?.[1]?.bowling?.score;
          if (playerScore && playerScore.balls > 0) {
            const playerInfo = teamPlayers[playerKey].player;
            
            // Check if player is from opposing team by examining their bowling data
            const oversBowled = playerScore.overs;
            if (oversBowled && (oversBowled[0] > 0 || oversBowled[1] > 0)) {
              const totalOvers = oversBowled[0] + (oversBowled[1] / 10);
              
              bowlingData.push({
                name: playerInfo.name,
                overs: totalOvers.toFixed(1),
                maidens: playerScore.maiden_overs || 0,
                runs: playerScore.runs || 0,
                wickets: playerScore.wickets || 0,
                economy: playerScore.economy?.toFixed(2) || '0.00'
              });
            }
          }
        }
      }
      
      // Calculate innings total and extras
      const extras = {
        total: inning.extra_runs?.extra || 0,
        bye: inning.extra_runs?.bye || 0,
        leg_bye: inning.extra_runs?.leg_bye || 0,
        wide: inning.extra_runs?.wide || 0,
        no_ball: inning.extra_runs?.no_ball || 0
      };
      
      const total = inning.score?.runs || 0;
      const overs = inning.overs ? `${inning.overs[0]}.${inning.overs[1]}` : '0.0';
      const runRate = inning.score?.run_rate?.toFixed(2) || '0.00';
      
      // Format the innings data
      processedInnings.push({
        team: matchData.teams[teamKey].name,
        batting: battingData,
        bowling: bowlingData,
        total: total.toString(),
        overs: overs,
        run_rate: runRate,
        extras: extras.total,
        bye: extras.bye,
        leg_bye: extras.leg_bye,
        wide: extras.wide,
        no_ball: extras.no_ball
      });
    }
    
    // Add close of play info
    const closeOfPlay = matchData.play?.close_of_play_msg || matchData.play?.result?.msg || null;
    
    return {
      match_key: matchData.key,
      match_status: matchData.status,
      innings: processedInnings,
      close_of_play: closeOfPlay
    };
    
  } catch (error) {
    console.error(`Error building detailed scorecard for ${matchData.key}:`, error);
    return {
      match_key: matchData.key,
      match_status: matchData.status,
      innings: [],
      close_of_play: null,
      error: 'Error building scorecard'
    };
  }
}

module.exports = router;


// // routes/webhooks.js
// const express = require('express');
// const zlib = require('zlib');
// const Match = require('../models/Match');
// const cacheService = require('../services/cacheService');
// const socketScorecardService = require('../services/socketScorecardService');
// const { REDIS_TTL_LIVE } = require('../config/constants');

// const router = express.Router();

// // Middleware to get raw body for webhook processing
// function rawBody(req, res, next) {
//   req.rawBody = '';
//   req.setEncoding('utf8');
//   req.on('data', function(chunk) {
//     req.rawBody += chunk;
//   });
//   req.on('end', function() {
//     next();
//   });
// }

// router.use(rawBody);

// // Webhook endpoint for Roanuz match updates
// router.post('/roanuz/match/feed/v1', async (req, res) => {
//   try {
//     console.log("inside request");
//     // Verify API key (if configured)
//     const API_KEY = process.env.ROANUZ_API_KEY;
//     if (API_KEY && req.headers['rs-api-key'] !== API_KEY) {
//       console.log('Webhook authentication failed');
//       return res.status(401).json({ status: false, error: 'Authentication failed' });
//     }

//     // Decompress the data if it's gzipped
//     let data;
//     if (req.headers['content-encoding'] === 'gzip') {
//       try {
//         const buffer = Buffer.from(req.rawBody, 'base64');
//         data = await new Promise((resolve, reject) => {
//           zlib.gunzip(buffer, (err, result) => {
//             if (err) reject(err);
//             else resolve(JSON.parse(result.toString()));
//           });
//         });
//       } catch (decompressError) {
//         console.error('Error decompressing webhook data:', decompressError);
//         return res.status(400).json({ status: false, error: 'Invalid compressed data' });
//       }
//     } else {
//       // If not compressed, parse as JSON directly
//       try {
//         data = JSON.parse(req.rawBody);
//       } catch (parseError) {
//         console.error('Error parsing webhook data:', parseError);
//         return res.status(400).json({ status: false, error: 'Invalid JSON data' });
//       }
//     }

//     console.log('📨 Received webhook update for match:', data.match_key);

//     // Process the webhook data
//     await processWebhookData(data);

//     res.json({ status: true, message: 'Webhook processed successfully' });
//   } catch (error) {
//     console.error('Error processing webhook:', error);
//     res.status(500).json({ status: false, error: 'Internal server error' });
//   }
// });

// // Process webhook data (similar to pollMatchDetailedScorecard)
// async function processWebhookData(webhookData) {
//   const matchKey = webhookData.match_key;
  
//   try {
//     // Build detailed scorecard using the same logic as before
//     const detailedScorecard = buildDetailedScorecard(webhookData);
    
//     // Update Redis caches
//     await Promise.all([
//       // Match details
//       cacheService.set(`match:${matchKey}`, webhookData, REDIS_TTL_LIVE),
      
//       // Detailed scorecard - key that frontend will read
//       cacheService.set(`scorecard-detailed:${matchKey}`, { data: detailedScorecard }, REDIS_TTL_LIVE)
//     ]);

//     // Push updates via socket
//     socketScorecardService.pushScorecardUpdate(matchKey, detailedScorecard);
    
//     // Update MongoDB backup
//     await Match.findOneAndUpdate(
//       { key: matchKey },
//       { 
//         ...webhookData,
//         detailed_scorecard: detailedScorecard,
//         last_updated: new Date(),
//         raw_data: webhookData
//       },
//       { upsert: true }
//     );
    
//     console.log(`✅ Updated detailed scorecard via webhook for ${matchKey}`);
//   } catch (error) {
//     console.error(`❌ Error processing webhook for ${matchKey}:`, error);
//   }
// }

// // Reuse the buildDetailedScorecard function from LiveMatchesPoller
// function buildDetailedScorecard(matchData) {
//   // Your existing implementation from LiveMatchesPoller
//   // ... (copy the exact same function here)
// }

// module.exports = router;




