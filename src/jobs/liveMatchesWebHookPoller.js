const cron = require('node-cron');
const Match = require('../models/Match');
const roanuzService = require('../services/roanuzService');
const cacheService = require('../services/cacheService');
const socketScorecardService = require('../services/socketScorecardService');
const { REDIS_TTL_LIVE, REDIS_TTL_SHORT, USE_WEBHOOK_SCORECARDS } = require('../config/constants');
const { buildDetailedScorecard } = require('../utils/scorecardBuilder'); // NEW: reuse builder

/**
 * Live Matches Poller
 *
 * 1) Every 30s: discover live matches (top 5) -> this remains
 * 2) If USE_WEBHOOK_SCORECARDS=true:
 *    - Subscribe to those matches via webhook (diff-based)
 *    - NO 5s polling; webhook will push updates
 * 3) Else (fallback):
 *    - Every 5s: poll detailed scorecard (original behavior)
 */
class LiveMatchesWebHookPoller {
  constructor() {
    this.currentLiveMatches = [];
    this.isPolling = false;

    // NEW: track what we’re subscribed to (Set for O(1) diff checks)
    this.subscribedMatches = new Set();
  }

  start() {
    console.log('🚀 Starting live matches poller with detailed scorecard...');

    // Every 30 seconds: discover live matches (UNCHANGED)
    cron.schedule('*/30 * * * * *', () => {
      this.discoverLiveMatches();
    });

    // CONDITIONAL: 5-second polling is now optional (for fallback only)
    if (!USE_WEBHOOK_SCORECARDS) {
      cron.schedule('*/5 * * * * *', () => {
        this.pollDetailedScorecards();
      });
    } else {
      console.log('🔔 Using WEBHOOK for detailed scorecards; 5s polling disabled.');
    }

    // Initial discovery
    this.discoverLiveMatches();
  }

  async discoverLiveMatches() {
    try {
      console.log('🔍 Discovering live matches...');

      const apiResponse = await roanuzService.getFeaturedMatches({
        useCache: true,
        cacheTTL: REDIS_TTL_SHORT,
      });

      if (!apiResponse?.data?.matches) {
        console.log('❌ No matches found from API');
        // NEW: if we had subscriptions previously, unsubscribe all to avoid stale pushes
        if (USE_WEBHOOK_SCORECARDS && this.subscribedMatches.size > 0) {
          await this._resubscribeDiff([]);
        }
        return;
      }

      const liveMatches = apiResponse.data.matches
        .filter(match => match.status === 'started')
        .slice(0, 5); // top 5 only

      const newLiveKeys = liveMatches.map(m => m.key);
      this.currentLiveMatches = newLiveKeys;

      console.log(`📡 Found ${newLiveKeys.length} live matches:`, newLiveKeys);

      // Cache the live matches list
      await cacheService.set('live_matches_keys', this.currentLiveMatches, REDIS_TTL_SHORT);

      // NEW: manage webhook subscriptions based on diffs
      if (USE_WEBHOOK_SCORECARDS) {
        await this._resubscribeDiff(newLiveKeys);
      }
    } catch (error) {
      console.error('❌ Error discovering live matches:', error);
    }
  }

  // NEW: diff-based subscription manager
  async _resubscribeDiff(newKeys) {
    const newSet = new Set(newKeys);

    // Keys to unsubscribe: present in subscribedMatches but not in newSet
    const toUnsubscribe = [...this.subscribedMatches].filter(k => !newSet.has(k));
    // Keys to subscribe: present in newSet but not in subscribedMatches
    const toSubscribe = [...newSet].filter(k => !this.subscribedMatches.has(k));

    if (toUnsubscribe.length > 0) {
      console.log('🔕 Unsubscribing from matches:', toUnsubscribe);
      await Promise.allSettled(
        toUnsubscribe.map(k => roanuzService.unsubscribeFromMatch(k))
      );
      toUnsubscribe.forEach(k => this.subscribedMatches.delete(k));
    }

    if (toSubscribe.length > 0) {
      console.log('🔔 Subscribing to matches:', toSubscribe);
      await Promise.allSettled(
        toSubscribe.map(k => roanuzService.subscribeToMatch(k))
      );
      toSubscribe.forEach(k => this.subscribedMatches.add(k));
    }
  }

  // ====== ORIGINAL 5s polling (kept for fallback only) ======
  async pollDetailedScorecards() {
    if (this.currentLiveMatches.length === 0) return;
    if (this.isPolling) return; // Prevent overlapping polls

    this.isPolling = true;

    try {
      console.log(`⚡ Polling detailed scorecards for ${this.currentLiveMatches.length} live matches...`);
      const pollingPromises = this.currentLiveMatches.map(matchKey =>
        this.pollMatchDetailedScorecard(matchKey)
      );
      await Promise.allSettled(pollingPromises);
    } catch (error) {
      console.error('❌ Error in polling detailed scorecards:', error);
    } finally {
      this.isPolling = false;
    }
  }

  // Kept intact (used only if USE_WEBHOOK_SCORECARDS=false)
  async pollMatchDetailedScorecard(matchKey) {
    try {
      const matchData = await roanuzService.getMatchDetails(matchKey, {
        useCache: false,
        cacheTTL: 5,
      });

      if (!matchData?.data) {
        console.warn(`⚠️ No data for match ${matchKey}`);
        return;
      }

      if (matchData.data.status !== 'started') {
        console.log(`🏁 Match ${matchKey} no longer live (status: ${matchData.data.status}) - removing from polling`);
        this.currentLiveMatches = this.currentLiveMatches.filter(k => k !== matchKey);
        return;
      }

      // Reuse the exact same builder (now from utils)
      const detailedScorecard = buildDetailedScorecard(matchData.data);

      await Promise.all([
        cacheService.set(`match:${matchKey}`, matchData, REDIS_TTL_LIVE),
        cacheService.set(`scorecard-detailed:${matchKey}`, { data: detailedScorecard }, REDIS_TTL_LIVE),
      ]);

      socketScorecardService.pushScorecardUpdate(matchKey, detailedScorecard);

      await Match.findOneAndUpdate(
        { key: matchKey },
        {
          ...matchData.data,
          detailed_scorecard: detailedScorecard,
          last_updated: new Date(),
          raw_data: matchData.data,
        },
        { upsert: true }
      );

      console.log(`✅ Updated detailed scorecard for ${matchKey} (${matchData.data.teams.a.name} vs ${matchData.data.teams.b.name})`);
    } catch (error) {
      console.error(`❌ Error polling detailed scorecard for ${matchKey}:`, error);
    }
  }
}

module.exports = LiveMatchesWebHookPoller;
