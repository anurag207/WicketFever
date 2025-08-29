require('./config/dotenv');

const express = require('express');
const http = require('http');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const connectDB = require('./config/db');
const { PORT, ROANUZ_API_URL, ROANUZ_PROJ_KEY, ROANUZ_API_KEY } = require('./config/constants');

const cacheService = require('./services/cacheService');
const socketScorecardService = require('./services/socketScorecardService');

const apiRoutes = require('./routes/api');
const matchRoutes = require('./routes/matchRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');
const countryRoutes = require('./routes/countryRoutes');
const monitorRoutes = require('./routes/monitorRoutes');
const searchRoutes = require('./routes/searchRoutes');
const newsRoutes = require('./routes/newsRoutes');
const profileRoutes = require('./routes/profileRoutes');
const webhookRoutes = require('./routes/webhook');

// const { ROANUZ_WEBHOOK_FEED_PATH } = require('./config/constants');
// const roanuzWebhookRouter = require('./routes/roanuzWebhook');

const rankingsRoutes = require('./routes/rankingsRoutes'); //unofficial
const unofficialRoutes = require('./routes/unofficialRoutes'); //unofficial

const app = express();

connectDB();

console.log('Environment variables:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', PORT);
console.log('ROANUZ_API_URL:', ROANUZ_API_URL);
console.log('ROANUZ_PROJ_KEY:', ROANUZ_PROJ_KEY);
console.log('ROANUZ_API_KEY provided:', ROANUZ_API_KEY ? 'Yes' : 'No');
console.log('REDIS_URL provided:', process.env.REDIS_URL ? 'Yes' : 'No');

app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS for all routes
app.use(morgan('dev')); // Request logging
app.use('/webhooks', webhookRoutes);

// app.use('/webhooks/roanuz', roanuzWebhookRouter);
app.use(express.json()); // Parse JSON request body

app.use('/api', apiRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/monitor', monitorRoutes);
app.use('/api/rankings', rankingsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/unofficial', unofficialRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/profile', profileRoutes);
// app.use('/webhooks/roanuz', roanuzWebhookRouter);
// app.get('/_debug/webhook-url', (req, res) => {
//   const base = `${req.protocol}://${req.get('host')}`;
//   const url = `${base}/webhooks/roanuz/match/feed/v1`;
//   res.json({ roanuz_webhook_url_to_set_in_console: url });
// });

app.get('/', (req, res) => {
  res.status(200).json({ 
    name: 'WicketFever API',
    version: '1.0.0',
    description: 'Cricket live score API for WicketFever app',
    endpoints: {
      matches: {
        featured: '/api/matches/featured',
        live: '/api/matches/live',
        upcoming: '/api/matches/upcoming',
        completed: '/api/matches/completed',
        details: '/api/matches/:matchKey',
        scorecard: '/api/matches/:matchKey/scorecard',
        summary: '/api/matches/:matchKey/summary',
        scorecardDetailed: '/api/matches/:matchKey/scorecard-detailed',
        statistics: '/api/matches/:matchKey/statistics',
        ballByBall: '/api/matches/:matchKey/ball-by-ball',
        tournamentMatches: '/api/matches/tournament/:tournamentKey'
      },
      tournaments: {
        all: '/api/tournaments',
        current: '/api/tournaments/current',
        featured: '/api/tournaments/featured',
        associations: '/api/tournaments/associations',
        associationTournaments: '/api/tournaments/association/:associationKey',
        details: '/api/tournaments/:tournamentKey',
        pointsTable: '/api/tournaments/:tournamentKey/points-table',
        fixtures: '/api/tournaments/:tournamentKey/fixtures',
        matches: '/api/tournaments/:tournamentKey/matches',
        featuredMatches: '/api/tournaments/:tournamentKey/featured-matches',
        teamPlayers: '/api/tournaments/:tournamentKey/team/:teamKey',
        upcomingByCountry: '/api/tournaments/upcoming/country/:countryCode',
        completedByCountry: '/api/tournaments/completed/country/:countryCode',
        featuredByCountry: '/api/tournaments/featured/country/:countryCode'
      },
      countries: {
        list: '/api/countries',
        sync: '/api/countries/sync',
        flag: '/api/countries/:countryCode/flag',
        update: '/api/countries/:countryCode'
      },
      monitor: {
        cacheStats: '/api/monitor/cache',
        clearCache: '/api/monitor/cache/clear'
      },
      rankings: {
        teams: '/api/rankings/teams?format=test&gender=men',
        players: '/api/rankings/players?category=batsmen&format=odi&gender=men',
        filters: '/api/rankings/filters',
        syncStatus: '/api/rankings/sync-status',
        summary: '/api/rankings/summary',
        forceSync: '/api/rankings/force-sync'
      },
      search: {
        universal: '/api/search?q=searchTerm&limit=20'
      },
      unofficial: {
        news: '/api/unofficial/news',
        playerComparison: '/api/unofficial/players/compare?player1Id=11808&player2Id=576'
      },
      news :{
        list: '/api/news',
      }
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

app.use((req, res, next) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'production' ? {} : err,
  });
});

const server = http.createServer(app);
// Initialize SocereCard Socket Service on top of http server for socket connections
socketScorecardService.initialize(server);

// Initialize Rankings Scheduler and Live Matches Poller after database connection
const rankingsScheduler = require('./jobs/rankingsScheduler');
// const LiveMatchesPoller = require('./jobs/liveMatchesPoller');
const LiveMatchesWebhook = require('./jobs/liveMatchesWebhook');
// const LiveMatchesWebHookPoller = require('./jobs/liveMatchesWebHookPoller');

const port = PORT;
server.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // console.log('Roanuz Webhook URL to set:', `http://localhost:${port}/webhooks/roanuz/match/feed/v1`);
  
  // Initialize rankings scheduler (handles initial sync and daily sync)
  try {
    await rankingsScheduler.initialize();
  } catch (error) {
    console.error('Rankings scheduler initialization failed:', error.message);
    console.log('Server will continue running, but rankings sync may not work properly.');
  }
  
  // Initialize live matches poller (polls top 5 live matches every 5 seconds)
  try {
    // const liveMatchesPoller = new LiveMatchesPoller();
    const liveMatchesWebhook = new LiveMatchesWebhook();
    // const liveMatchesWebHookPoller = new LiveMatchesWebHookPoller();
    liveMatchesWebhook.start();
    // liveMatchesWebHookPoller.start();
    console.log('✅ Live matches poller started successfully');
  } catch (error) {
    console.error('❌ Live matches poller initialization failed:', error.message);
    console.log('Server will continue running, but live match polling may not work properly.');
  }
});

module.exports = { app, server }; 