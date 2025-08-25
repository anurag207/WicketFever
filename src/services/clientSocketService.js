const socketIO = require('socket.io');
const roanuzService = require('./roanuzService');
const cacheService = require('./cacheService');

class SocketService {
  constructor() {
    this.io = null;
    this.activeMatchKeys = new Set();
    this.updateIntervals = {};
  }

  /**
   * Initialize Socket.IO server
   * @param {object} server - HTTP server instance
   */
  initialize(server) {
    this.io = socketIO(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    this.setupSocketEvents();
    console.log('Socket.IO initialized');
  }

  /**
   * Set up socket connection events
   */
  setupSocketEvents() {
    this.io.on('connection', (socket) => {
      console.log(`New client connected: ${socket.id}`);

      // Handle client subscribing to a match
      socket.on('subscribe_match', (matchKey) => {
        this.handleMatchSubscription(socket, matchKey);
      });

      // Handle client unsubscribing from a match
      socket.on('unsubscribe_match', (matchKey) => {
        this.handleMatchUnsubscription(socket, matchKey);
      });

      // Handle client disconnection
      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        this.cleanupSubscriptions(socket);
      });
    });
  }

  /**
   * Handle match subscription
   * @param {object} socket - Socket instance
   * @param {string} matchKey - Match key to subscribe to
   */
  handleMatchSubscription(socket, matchKey) {
    socket.join(`match:${matchKey}`);
    console.log(`Client ${socket.id} subscribed to match: ${matchKey}`);

    // Store matchKey in socket for cleanup
    if (!socket.subscribedMatches) {
      socket.subscribedMatches = new Set();
    }
    socket.subscribedMatches.add(matchKey);

    // Start updating match data if not already active
    if (!this.activeMatchKeys.has(matchKey)) {
      this.activeMatchKeys.add(matchKey);
      this.startMatchUpdates(matchKey);
    }
  }

  /**
   * Handle match unsubscription
   * @param {object} socket - Socket instance
   * @param {string} matchKey - Match key to unsubscribe from
   */
  handleMatchUnsubscription(socket, matchKey) {
    socket.leave(`match:${matchKey}`);
    console.log(`Client ${socket.id} unsubscribed from match: ${matchKey}`);

    if (socket.subscribedMatches) {
      socket.subscribedMatches.delete(matchKey);
    }

    // Check if room is empty to stop updates
    this.checkAndCleanupMatch(matchKey);
  }

  /**
   * Clean up subscriptions when socket disconnects
   * @param {object} socket - Socket instance
   */
  cleanupSubscriptions(socket) {
    if (socket.subscribedMatches) {
      for (const matchKey of socket.subscribedMatches) {
        socket.leave(`match:${matchKey}`);
        this.checkAndCleanupMatch(matchKey);
      }
      socket.subscribedMatches.clear();
    }
  }

  /**
   * Check if match room is empty and cleanup if needed
   * @param {string} matchKey - Match key to check
   */
  checkAndCleanupMatch(matchKey) {
    const room = this.io.sockets.adapter.rooms.get(`match:${matchKey}`);
    
    if (!room || room.size === 0) {
      this.stopMatchUpdates(matchKey);
      this.activeMatchKeys.delete(matchKey);
      console.log(`No more subscribers for match ${matchKey}, stopped updates`);
    }
  }

  /**
   * Start periodic updates for a match
   * @param {string} matchKey - Match key to update
   */
  startMatchUpdates(matchKey) {
    // Check match status first to determine update frequency
    this.fetchAndEmitMatchData(matchKey)
      .then(matchData => {
        const updateFrequency = this.getUpdateFrequency(matchData.data.status);
        
        // Start interval updates
        this.updateIntervals[matchKey] = setInterval(() => {
          this.fetchAndEmitMatchData(matchKey);
        }, updateFrequency);
        
        console.log(`Started updates for match ${matchKey} every ${updateFrequency / 1000} seconds`);
      })
      .catch(error => {
        console.error(`Error starting updates for match ${matchKey}:`, error);
      });
  }

  /**
   * Stop periodic updates for a match
   * @param {string} matchKey - Match key to stop updates for
   */
  stopMatchUpdates(matchKey) {
    if (this.updateIntervals[matchKey]) {
      clearInterval(this.updateIntervals[matchKey]);
      delete this.updateIntervals[matchKey];
      console.log(`Stopped updates for match ${matchKey}`);
    }
  }

  /**
   * Fetch and emit match data to subscribers
   * @param {string} matchKey - Match key to fetch and emit
   * @returns {Promise} Match data
   */
  async fetchAndEmitMatchData(matchKey) {
    try {
      // Use short cache duration for live matches
      const cacheKey = `match:${matchKey}`;
      const matchData = await cacheService.fetchWithCache(
        cacheKey,
        () => roanuzService.getMatchDetails(matchKey),
        30 // 30 seconds cache for live match data
      );

      // Emit to subscribers
      this.io.to(`match:${matchKey}`).emit('match_update', matchData);
      
      // If match is completed, stop updates after a while
      if (matchData.data.status === 'completed') {
        setTimeout(() => {
          this.stopMatchUpdates(matchKey);
        }, 5 * 60 * 1000); // Stop after 5 minutes of completion
      }
      
      return matchData;
    } catch (error) {
      console.error(`Error fetching and emitting match data for ${matchKey}:`, error);
      throw error;
    }
  }

  /**
   * Get update frequency based on match status
   * @param {string} status - Match status
   * @returns {number} Update frequency in milliseconds
   */
  getUpdateFrequency(status) {
    switch (status) {
      case 'started':
        return 30 * 1000; // 30 seconds for live matches
      case 'not_started':
        return 5 * 60 * 1000; // 5 minutes for upcoming matches
      case 'completed':
        return 10 * 60 * 1000; // 10 minutes for completed matches
      default:
        return 60 * 1000; // 1 minute default
    }
  }

  /**
   * Emit data to all connected clients
   * @param {string} event - Event name
   * @param {any} data - Data to emit
   */
  emitToAll(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }
}

module.exports = new SocketService(); 