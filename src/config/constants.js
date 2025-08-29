module.exports = {
  ROANUZ_API_URL: process.env.ROANUZ_API_URL || 'https://api.sports.roanuz.com/v5',
  ROANUZ_PROJ_KEY: process.env.ROANUZ_PROJ_KEY ,
  ROANUZ_API_KEY: process.env.ROANUZ_API_KEY,
  MONGODB_URI: process.env.MONGODB_URI ,
  JWT_SECRET: process.env.JWT_SECRET,
  PORT: process.env.PORT || 5000,
  REDIS_URL: process.env.REDIS_URL ,
  BASE_URL: process.env.BASE_URL || 'http://localhost:5000',
  
  // RapidAPI Unofficial Cricbuzz for ICC Rankings
  RAPID_API_HOST: process.env.RAPID_API_HOST || 'unofficial-cricbuzz.p.rapidapi.com',
  RAPID_API_KEY: process.env.RAPID_API_KEY,
  CRICBUZZ_API_URL: process.env.CRICBUZZ_API_URL || 'https://unofficial-cricbuzz.p.rapidapi.com',
  
  REDIS_TTL_LIVE: process.env.REDIS_TTL_LIVE || 10, // 10 seconds
  REDIS_TTL_SHORT: process.env.REDIS_TTL_SHORT || 900, // 15 minutes
  REDIS_TTL_MEDIUM: process.env.REDIS_TTL_MEDIUM || 86400, // 1 day
  REDIS_TTL_LONG: process.env.REDIS_TTL_LONG || 604800, // 7 days
  
  // Rankings specific cache TTL (6 hours - rankings don't change frequently)
  REDIS_TTL_RANKINGS: process.env.REDIS_TTL_RANKINGS || 21600, // 6 hours

  DEFAULT_FLAG_SVG: process.env.DEFAULT_FLAG_SVG || '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M14 6l-1-2H5v17h2v-7h5l1 2h7V6h-6zm4 8h-4l-1-2H7V6h5l1 2h5v6z"/></svg>',

  DEFAULT_PLAYER_IMAGE: process.env.DEFAULT_PLAYER_IMAGE || 'https://cdn-icons-png.flaticon.com/512/847/847969.png',
  // NEW: feature flag to switch detailed scorecard updates to webhook
  // USE_WEBHOOK_SCORECARDS: process.env.USE_WEBHOOK_SCORECARDS === 'true',

  // NEW: webhook path + API key used for verifying incoming requests
  // ROANUZ_WEBHOOK_API_KEY: process.env.ROANUZ_WEBHOOK_API_KEY,
  // ROANUZ_WEBHOOK_FEED_PATH: process.env.ROANUZ_WEBHOOK_FEED_PATH || '/webhooks/roanuz/match/feed/v1',
}; 