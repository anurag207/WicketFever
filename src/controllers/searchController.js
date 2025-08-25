const Match = require('../models/Match');
const Tournament = require('../models/Tournament');
const Team = require('../models/Team');
const BestPerformers = require('../models/BestPerformers');
const Country = require('../models/Country');

/**
 * Universal search across all collections (except ICCRanking)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.universalSearch = async (req, res) => {
  try {
    const { q: query, limit = 20 } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ 
        message: 'Query must be at least 2 characters long',
        results: []
      });
    }

    const searchTerm = query.trim();
    const searchLimit = Math.min(parseInt(limit), 100); // Cap at 100 results
    const results = [];

    // Create regex for case-insensitive search
    const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Search in parallel across all collections
    const searchPromises = [
      searchMatches(searchRegex, searchLimit),
      searchTournaments(searchRegex, searchLimit),
      searchTeams(searchRegex, searchLimit),
      searchPlayers(searchRegex, searchLimit),
      searchCountries(searchRegex, searchLimit)
    ];

    const searchResults = await Promise.all(searchPromises);
    
    // Flatten and combine all results
    searchResults.forEach(collectionResults => {
      results.push(...collectionResults);
    });

    // Sort results by relevance (exact matches first, then partial matches)
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === searchTerm.toLowerCase() ? 1 : 0;
      const bExact = b.name.toLowerCase() === searchTerm.toLowerCase() ? 1 : 0;
      
      if (aExact !== bExact) return bExact - aExact;
      
      // Secondary sort by name length (shorter names first for partial matches)
      return a.name.length - b.name.length;
    });

    // Limit final results
    const limitedResults = results.slice(0, searchLimit);

    res.json({
      query: searchTerm,
      total_results: limitedResults.length,
      results: limitedResults
    });

  } catch (error) {
    console.error('Universal search error:', error);
    res.status(500).json({ 
      message: 'Search failed', 
      error: error.message,
      results: []
    });
  }
};

/**
 * Search matches collection
 */
async function searchMatches(searchRegex, limit) {
  const matches = await Match.find({
    $or: [
      { name: searchRegex },
      { short_name: searchRegex },
      { sub_title: searchRegex },
      { 'teams.a.name': searchRegex },
      { 'teams.b.name': searchRegex },
      { 'teams.a.alternate_name': searchRegex },
      { 'teams.b.alternate_name': searchRegex },
      { 'tournament.name': searchRegex },
      { 'tournament.short_name': searchRegex },
      { 'venue.name': searchRegex },
      { 'venue.city': searchRegex },
      { 'venue.country.name': searchRegex }
    ]
  })
  .select('key name short_name teams tournament venue status start_at format')
  .limit(limit)
  .lean();

  return matches.map(match => ({
    type: 'match',
    key: match.key,
    name: match.name,
    short_name: match.short_name,
    metadata: {
      teams: {
        a: {
          key: match.teams?.a?.key,
          name: match.teams?.a?.name,
          code: match.teams?.a?.code
        },
        b: {
          key: match.teams?.b?.key,
          name: match.teams?.b?.name,
          code: match.teams?.b?.code
        }
      },
      tournament: {
        key: match.tournament?.key,
        name: match.tournament?.name
      },
      venue: match.venue?.name,
      status: match.status,
      format: match.format,
      start_at: match.start_at
    }
  }));
}

/**
 * Search tournaments collection
 */
async function searchTournaments(searchRegex, limit) {
  const tournaments = await Tournament.find({
    $or: [
      { name: searchRegex },
      { short_name: searchRegex },
      { alternate_name: searchRegex },
      { 'association.name': searchRegex }
    ]
  })
  .select('key name short_name alternate_name status format gender association start_date end_date')
  .limit(limit)
  .lean();

  return tournaments.map(tournament => ({
    type: 'tournament',
    key: tournament.key,
    name: tournament.name,
    short_name: tournament.short_name,
    metadata: {
      alternate_name: tournament.alternate_name,
      status: tournament.status,
      format: tournament.format,
      gender: tournament.gender,
      association: tournament.association,
      start_date: tournament.start_date,
      end_date: tournament.end_date
    }
  }));
}

/**
 * Search teams collection
 */
async function searchTeams(searchRegex, limit) {
  const teams = await Team.find({
    $or: [
      { name: searchRegex },
      { code: searchRegex },
      { alternate_name: searchRegex },
      { alternate_code: searchRegex },
      { country_code: searchRegex }
    ]
  })
  .select('key name code alternate_name alternate_code country_code type gender_name')
  .limit(limit)
  .lean();

  return teams.map(team => ({
    type: 'team',
    key: team.key,
    name: team.name,
    code: team.code,
    metadata: {
      alternate_name: team.alternate_name,
      alternate_code: team.alternate_code,
      country_code: team.country_code,
      type: team.type,
      gender_name: team.gender_name
    }
  }));
}

/**
 * Search players in teams and best performers
 */
async function searchPlayers(searchRegex, limit) {
  const players = [];
  
  // Search in teams collection for players
  const teamsWithPlayers = await Team.find({
    'players.name': searchRegex
  })
  .select('players name code key')
  .limit(limit)
  .lean();

  teamsWithPlayers.forEach(team => {
    const matchingPlayers = team.players.filter(player => 
      searchRegex.test(player.name)
    );
    
    matchingPlayers.forEach(player => {
      players.push({
        type: 'player',
        key: player.key,
        name: player.name,
        metadata: {
          team_key: team.key,
          team_name: team.name,
          team_code: team.code,
          playing_role: player.playing_role,
          batting_style: player.batting_style,
          bowling_style: player.bowling_style,
          captain: player.captain,
          keeper: player.keeper
        }
      });
    });
  });

  // Search in best performers for players
  const bestPerformers = await BestPerformers.find({
    $or: [
      { 'data.batters.name': searchRegex },
      { 'data.bowlers.name': searchRegex }
    ]
  })
  .select('match_key data type')
  .limit(limit)
  .lean();

  bestPerformers.forEach(performance => {
    // Check batters
    if (performance.data.batters) {
      performance.data.batters.forEach(batter => {
        if (searchRegex.test(batter.name)) {
          players.push({
            type: 'player',
            key: batter.player_key,
            name: batter.name,
            metadata: {
              match_key: performance.match_key,
              team: batter.team,
              team_name: batter.team_name,
              performance_type: 'batting',
              runs: batter.runs,
              balls: batter.balls,
              strike_rate: batter.strike_rate
            }
          });
        }
      });
    }

    // Check bowlers
    if (performance.data.bowlers) {
      performance.data.bowlers.forEach(bowler => {
        if (searchRegex.test(bowler.name)) {
          players.push({
            type: 'player',
            key: bowler.player_key,
            name: bowler.name,
            metadata: {
              match_key: performance.match_key,
              team: bowler.team,
              team_name: bowler.team_name,
              performance_type: 'bowling',
              overs: bowler.overs,
              wickets: bowler.wickets,
              economy: bowler.economy
            }
          });
        }
      });
    }
  });

  // Remove duplicates based on player key
  const uniquePlayers = players.reduce((acc, player) => {
    if (!acc.find(p => p.key === player.key && p.name === player.name)) {
      acc.push(player);
    }
    return acc;
  }, []);

  return uniquePlayers.slice(0, limit);
}

/**
 * Search countries collection
 */
async function searchCountries(searchRegex, limit) {
  const countries = await Country.find({
    $or: [
      { name: searchRegex },
      { official_name: searchRegex },
      { code: searchRegex },
      { short_code: searchRegex }
    ]
  })
  .select('code short_code name official_name')
  .limit(limit)
  .lean();

  return countries.map(country => ({
    type: 'country',
    key: country.code,
    name: country.name,
    code: country.code,
    metadata: {
      short_code: country.short_code,
      official_name: country.official_name
    }
  }));
} 