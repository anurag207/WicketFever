// // routes/roanuzWebhook.js
// const express = require('express');
// const bodyParser = require('body-parser');
// const zlib = require('zlib');

// const router = express.Router();

// const cacheService = require('../services/cacheService');
// const socketScorecardService = require('../services/socketScorecardService');
// const Match = require('../models/Match');
// const { buildDetailedScorecard } = require('../utils/scorecardBuilder');
// const { ROANUZ_WEBHOOK_API_KEY, REDIS_TTL_LIVE } = require('../config/constants');

// // -- Capture raw bytes for zipped body (as per Roanuz docs) --
// function rawBody(req, res, next) {
//   req.chunks = [];
//   req.on('data', chunk => {
//     req.chunks.push(Buffer.from(chunk));
//   });
//   req.on('end', () => next());
// }

// // We keep bodyParser.json to not break other routes.
// // Roanuz payload is zipped binary — we won't use req.body for it.
// router.use(bodyParser.json());
// router.use(rawBody);

// /**
//  * POST /webhooks/roanuz/match/feed/v1
//  * This path must match ROANUZ_WEBHOOK_FEED_PATH and the URL set in Roanuz Console.
//  */
// router.post('/match/feed/v1', async (req, res) => {
//   // 1) Verify signature via header 'rs-api-key'
//   if (req.headers['rs-api-key'] !== ROANUZ_WEBHOOK_API_KEY) {
//     console.log('Roanuz Webhook: Auth failed');
//     return res.status(401).json({ status: false, error: 'Unauthorized' });
//     // IMPORTANT: do not unzip or parse if not authorized.
//   }

//   try {
//     // 2) Unzip the raw zipped body and parse JSON
//     const zipped = Buffer.concat(req.chunks || []);
//     zlib.unzip(zipped, async (err, buffer) => {
//       if (err) {
//         console.error('Roanuz Webhook: unzip error', err);
//         return res.status(400).json({ status: false, error: 'Invalid compressed payload' });
//       }

//       // Roanuz typically sends full match JSON here
//       let payload;
//       try {
//         payload = JSON.parse(buffer.toString());
//       } catch (parseErr) {
//         console.error('Roanuz Webhook: JSON parse error', parseErr);
//         return res.status(400).json({ status: false, error: 'Invalid JSON' });
//       }

//       // 3) Normalize data shape: some integrations send {data: {...}}; handle both
//       const matchData = payload?.data?.key ? payload.data : payload;
//       const matchKey = matchData?.key;

//       if (!matchKey) {
//         console.warn('Roanuz Webhook: payload missing match key');
//         return res.status(200).json({ status: true }); // Ack to avoid retries, but log the issue
//       }

//       // 4) Build the same "detailed scorecard" you use in polling path
//       const detailedScorecard = buildDetailedScorecard(matchData);

//       // 5) Update Redis caches (keep keys identical to poller)
//       await Promise.all([
//         cacheService.set(`match:${matchKey}`, { data: matchData }, REDIS_TTL_LIVE),
//         cacheService.set(`scorecard-detailed:${matchKey}`, { data: detailedScorecard }, REDIS_TTL_LIVE),
//       ]);

//       // 6) Emit to frontend via the SAME socket service
//       try {
//         socketScorecardService.pushScorecardUpdate(matchKey, detailedScorecard);
//       } catch (e) {
//         console.error('Roanuz Webhook: socket push failed', e.message);
//       }

//       // 7) Upsert in MongoDB (backup)
//       try {
//         await Match.findOneAndUpdate(
//           { key: matchKey },
//           {
//             ...matchData,
//             detailed_scorecard: detailedScorecard,
//             last_updated: new Date(),
//             raw_data: matchData,
//           },
//           { upsert: true }
//         );
//       } catch (e) {
//         console.error('Roanuz Webhook: Mongo upsert failed', e.message);
//       }

//       // 8) ACK to Roanuz (important)
//       return res.status(200).json({ status: true });
//     });
//   } catch (e) {
//     console.error('Roanuz Webhook: handler error', e);
//     return res.status(500).json({ status: false });
//   }
// });

// module.exports = router;


//SECOND CODE

// routes/roanuzWebhook.js
// const express = require('express');
// // ❌ bodyParser/json would consume the stream before we can unzip
// // const bodyParser = require('body-parser');
// const zlib = require('zlib');

// const router = express.Router();

// const cacheService = require('../services/cacheService');
// const socketScorecardService = require('../services/socketScorecardService');
// const Match = require('../models/Match');
// const { buildDetailedScorecard } = require('../utils/scorecardBuilder');
// const { ROANUZ_WEBHOOK_API_KEY, REDIS_TTL_LIVE } = require('../config/constants');

// /**
//  * IMPORTANT MIDDLEWARE NOTE
//  * -------------------------
//  * Roanuz sends gzipped payloads. We must read the **raw bytes**.
//  * Use express.raw() on THIS route only (so global express.json() won’t eat the stream).
//  *
//  * We avoid router.use(bodyParser.json()) here entirely.
//  */

// router.post(
//   '/match/feed/v1',
//   // ⬇️ Route-scoped raw parser; allow any content-type; limit ~2MB (tweak as needed)
//   express.raw({ type: '*/*', limit: '2mb' }),
//   async (req, res) => {
//     const startedAt = Date.now();

//     // 1) Verify signature via header 'rs-api-key'
//     const incomingKey = req.headers['rs-api-key'];
//     if (incomingKey !== ROANUZ_WEBHOOK_API_KEY) {
//       console.log('[Roanuz WH] ❌ Auth failed: rs-api-key mismatch');
//       return res.status(401).json({ status: false, error: 'Unauthorized' });
//     }

//     // Some useful header logs (once per request)
//     console.log('--- Roanuz Webhook START -----------------------------');
//     console.log('[Roanuz WH] Path:', req.originalUrl);
//     console.log('[Roanuz WH] Content-Encoding:', req.headers['content-encoding']);
//     console.log('[Roanuz WH] Content-Type:', req.headers['content-type']);
//     console.log('[Roanuz WH] Raw bytes length:', req.body?.length ?? 0);

//     // 2) Unzip the raw gzipped body and parse JSON
//     // Roanuz typically uses gzip; zlib will handle if compressed.
//     const zipped = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
//     zlib.unzip(zipped, async (unzipErr, buffer) => {
//       if (unzipErr) {
//         console.error('[Roanuz WH] ❌ unzip error:', unzipErr.message);
//         // Sometimes they may send plain JSON for tests; try parse as-is:
//         try {
//           const asText = zipped.toString('utf8');
//           const maybeJSON = JSON.parse(asText);
//           console.warn('[Roanuz WH] ⚠️ Payload appeared uncompressed; parsed plain JSON');
//           return await handleParsedPayload(maybeJSON);
//         } catch (plainErr) {
//           console.error('[Roanuz WH] ❌ Fallback plain JSON parse failed:', plainErr.message);
//           return res.status(400).json({ status: false, error: 'Invalid compressed payload' });
//         }
//       }

//       // Parse JSON
//       let payload;
//       try {
//         payload = JSON.parse(buffer.toString('utf8'));
//       } catch (parseErr) {
//         console.error('[Roanuz WH] ❌ JSON parse error:', parseErr.message);
//         return res.status(400).json({ status: false, error: 'Invalid JSON' });
//       }

//       // Delegate the rest so we can share with fallback path above
//       await handleParsedPayload(payload);
//     });

//     // ---- Helper does the remainder of the flow & sends response ----
//     const handleParsedPayload = async (payload) => {
//       // 3) Normalize data shape
//       const matchData = payload?.data?.key ? payload.data : payload;
//       const matchKey = matchData?.key;

//       console.log('[Roanuz WH] Parsed keys:', {
//         hasDataWrapper: !!payload?.data,
//         matchKey,
//         status: matchData?.status,
//         teams: matchData?.teams ? Object.keys(matchData.teams) : undefined,
//       });

//       if (!matchKey) {
//         console.warn('[Roanuz WH] ⚠️ Missing match key in payload; acking to avoid retry');
//         console.log('--- Roanuz Webhook END (missing key) ---------------');
//         return res.status(200).json({ status: true });
//       }

//       // 4) Build your “detailed scorecard”
//       let detailedScorecard;
//       try {
//         detailedScorecard = buildDetailedScorecard(matchData);
//         console.log('[Roanuz WH] ✅ Built detailedScorecard');
//       } catch (e) {
//         console.error('[Roanuz WH] ❌ buildDetailedScorecard failed:', e.message);
//         // Still proceed with raw matchData to not drop updates
//         detailedScorecard = null;
//       }

//       // 5) Update Redis caches
//       try {
//         await Promise.all([
//           cacheService.set(`match:${matchKey}`, { data: matchData }, REDIS_TTL_LIVE),
//           cacheService.set(
//             `scorecard-detailed:${matchKey}`,
//             { data: detailedScorecard ?? { fallback: true, raw: matchData } },
//             REDIS_TTL_LIVE
//           ),
//         ]);
//         console.log('[Roanuz WH] ✅ Redis updated', {
//           keys: [`match:${matchKey}`, `scorecard-detailed:${matchKey}`],
//           ttl: REDIS_TTL_LIVE,
//         });
//       } catch (e) {
//         console.error('[Roanuz WH] ❌ Redis set failed:', e.message);
//       }

//       // 6) Emit to frontend via Socket
//       try {
//         socketScorecardService.pushScorecardUpdate(
//           matchKey,
//           detailedScorecard ?? { fallback: true, raw: matchData }
//         );
//         console.log('[Roanuz WH] ✅ Socket emitted for', matchKey);
//       } catch (e) {
//         console.error('[Roanuz WH] ❌ Socket push failed:', e.message);
//       }

//       // 7) Upsert in MongoDB (optional backup)
//       try {
//         const updateDoc = {
//           ...matchData,
//           detailed_scorecard: detailedScorecard,
//           last_updated: new Date(),
//           raw_data: matchData,
//         };
//         await Match.findOneAndUpdate({ key: matchKey }, updateDoc, { upsert: true });
//         console.log('[Roanuz WH] ✅ Mongo upsert ok for', matchKey);
//       } catch (e) {
//         console.error('[Roanuz WH] ❌ Mongo upsert failed:', e.message);
//       }

//       // 8) ACK to Roanuz — do this quickly (<3s)
//       const tookMs = Date.now() - startedAt;
//       console.log('[Roanuz WH] ✅ ACK 200 (took ms):', tookMs);
//       console.log('--- Roanuz Webhook END -----------------------------');
//       return res.status(200).json({ status: true });
//     };
//   }
// );

// module.exports = router;



