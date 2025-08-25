const cron = require('node-cron');
const cricbuzzSyncService = require('../services/cricbuzzSyncService');

/**
 * Rankings Scheduler
 * Handles scheduled syncing of ICC rankings
 */
class RankingsScheduler {
  constructor() {
    this.syncJob = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the scheduler
   */
  async initialize() {
    try {
      console.log('Initializing Rankings Scheduler...');
      
      // Check if initial sync is needed (on server startup)
      await this.checkAndPerformInitialSync();
      
      // Start the daily sync job
      this.startDailySync();
      
      this.isInitialized = true;
      console.log('✓ Rankings Scheduler initialized successfully');
    } catch (error) {
      console.error('✗ Failed to initialize Rankings Scheduler:', error.message);
      throw error;
    }
  }

  /**
   * Check if initial sync is needed and perform it
   */
  async checkAndPerformInitialSync() {
    try {
      const isInitialSyncNeeded = await cricbuzzSyncService.isInitialSyncNeeded();
      
      if (isInitialSyncNeeded) {
        console.log('No rankings data found. Performing initial sync...');
        await this.performSync('Initial sync on startup');
      } else {
        console.log('Rankings data exists. Skipping initial sync.');
        
        // Log last sync info
        const status = await cricbuzzSyncService.getSyncStatus();
        if (status.lastSync) {
          console.log(`Last sync: ${status.lastSync.batch} at ${status.lastSync.timestamp}`);
          console.log(`Total rankings in database: ${status.totalRankings}`);
        }
      }
    } catch (error) {
      console.error('Error during initial sync check:', error.message);
      // Don't throw here - let the application start even if initial sync fails
      // The daily sync will catch up later
    }
  }

  /**
   * Start the daily sync job (runs at 3:00 AM every day)
   */
  startDailySync() {
    // Cron expression: 0 3 * * * (At 3:00 AM every day)
    this.syncJob = cron.schedule('0 3 * * *', async () => {
      await this.performSync('Scheduled daily sync');
    }, {
      scheduled: true,
      timezone: 'UTC' // You can change this to your timezone
    });

    console.log('✓ Daily sync job scheduled for 3:00 AM UTC');
  }

  /**
   * Perform the actual sync operation
   */
  async performSync(reason = 'Manual sync') {
    const startTime = Date.now();
    console.log(`\n🔄 Starting ICC rankings sync: ${reason}`);
    console.log(`Started at: ${new Date().toISOString()}`);
    
    try {
      const result = await cricbuzzSyncService.syncAllRankings();
      
      const duration = Date.now() - startTime;
      console.log(`\n✅ ICC rankings sync completed successfully!`);
      console.log(`Duration: ${Math.round(duration / 1000)}s`);
      console.log(`Sync batch: ${result.syncBatch}`);
      console.log(`Total rankings synced: ${result.totalRankings}`);
      console.log(`Completed at: ${new Date().toISOString()}\n`);
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`\n❌ ICC rankings sync failed after ${Math.round(duration / 1000)}s`);
      console.error(`Error: ${error.message}`);
      console.error(`Failed at: ${new Date().toISOString()}\n`);
      
      // Don't rethrow in scheduled jobs to prevent crashes
      if (reason.includes('Manual') || reason.includes('Initial')) {
        throw error;
      }
    }
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.syncJob) {
      this.syncJob.stop();
      console.log('Rankings sync job stopped');
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      dailySyncActive: this.syncJob ? true : false,
      nextScheduledRun: this.syncJob ? 'Daily at 3:00 AM UTC' : null
    };
  }

  /**
   * Trigger manual sync
   */
  async triggerManualSync() {
    if (!this.isInitialized) {
      throw new Error('Scheduler not initialized');
    }
    
    return await this.performSync('Manual sync triggered');
  }
}

module.exports = new RankingsScheduler(); 