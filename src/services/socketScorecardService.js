// services/socketScorecardService.js
const socketIO = require('socket.io');

class SocketScorecardService {
  constructor() {
    this.io = null;
    this.connectedClients = new Map(); // Map<matchKey, Set<socketId>> Keeps track of socket ids for a particular match ke
  }

  logConnectedClients() { // helper function for debugging connectedClients map
    const summary = {};
    this.connectedClients.forEach((clients, matchKey) => {
      summary[matchKey] = Array.from(clients);
    });
    console.log('📊 Current connectedClients map:', JSON.stringify(summary, null, 2));
  }
  

  /**
   * Initialize Socket.IO server
   * @param {http.Server} server - HTTP server instance
   */
  initialize(server) {
    this.io = socketIO(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      },
      transports: ['websocket', 'polling']
    });

    this.setupEventHandlers();
    console.log('✅ SocketScorecardService initialized');
  }

  /**
   * Set up socket connection and event handlers
   */
  setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`⚡ Client connected: ${socket.id}`);

      // Handle subscription to match scorecard updates
      socket.on('subscribe_scorecard', (matchKey) => {
        this.handleSubscription(socket, matchKey);
      });

      // Handle unsubscription from match scorecard updates
      socket.on('unsubscribe_scorecard', (matchKey) => {
        this.handleUnsubscription(socket, matchKey);
      });

      // Handle client disconnection
      socket.on('disconnect', () => {
        this.handleDisconnection(socket);
        console.log(`❌ Client disconnected: ${socket.id}`);
      });
    });
  }

  /**
   * Handle client subscription to a match's scorecard updates
   * @param {Socket} socket - Socket instance
   * @param {string} matchKey - Match key to subscribe to
   */
  handleSubscription(socket, matchKey) {
    if (!this.connectedClients.has(matchKey)) {
      this.connectedClients.set(matchKey, new Set());
    }

    const matchClients = this.connectedClients.get(matchKey);
    matchClients.add(socket.id);
    socket.join(`scorecard:${matchKey}`); //creates a room for a particular matchkey so that all subscirbers(socketIDs) for that match key are pushed updates at once
    
    console.log(`📢 Client ${socket.id} subscribed to match: ${matchKey}`);
    this.logConnectedClients();
  }

  /**
   * Handle client unsubscription from a match's scorecard updates
   * @param {Socket} socket - Socket instance
   * @param {string} matchKey - Match key to unsubscribe from
   */
  handleUnsubscription(socket, matchKey) {
    if (this.connectedClients.has(matchKey)) {
      const matchClients = this.connectedClients.get(matchKey);
      matchClients.delete(socket.id); //deletes the corresponding subscriber of particular match key
      socket.leave(`scorecard:${matchKey}`);
      
      console.log(`📢 Client ${socket.id} unsubscribed from match: ${matchKey}`);
      
      // Clean up the match key in map if no clients are listening
      if (matchClients.size === 0) {
        this.connectedClients.delete(matchKey);
      }
    }
  }

  /**
   * Handle client disconnection
   * @param {Socket} socket - Socket instance
   */
  handleDisconnection(socket) {
    // Remove client from all match subscriptions
    this.connectedClients.forEach((clients, matchKey) => {
      if (clients.has(socket.id)) {
        clients.delete(socket.id);
        if (clients.size === 0) {
          this.connectedClients.delete(matchKey);
        }
      }
    });
  }

  /**
   * Push scorecard update to all subscribed clients
   * @param {string} matchKey - Match key to update
   * @param {object} scorecardData - Detailed scorecard data
   */
  pushScorecardUpdate(matchKey, scorecardData) {
    if (!this.io) {
      console.warn('Socket.io not initialized');
      return;
    }

    if (this.connectedClients.has(matchKey)) {
      this.io.to(`scorecard:${matchKey}`).emit('scorecard_update', { //emit updates to all subscribers of a particular room (determined by match key)
        matchKey,
        data: scorecardData,
        timestamp: new Date().toISOString()
      });
      console.log(`📢 Pushed scorecard update for match: ${matchKey}`);
      console.log("connected clietns inside pushscoreboard");
      this.logConnectedClients();
    }
  }
}

module.exports = new SocketScorecardService();