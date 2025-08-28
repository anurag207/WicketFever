// utils/scorecardBuilder.js
/**
 * NOTE: This is copied from your LiveMatchesPoller.buildDetailedScorecard with tiny tweaks
 * so both Poller and Webhook handler produce IDENTICAL client payloads.
 */
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
  
  module.exports = { buildDetailedScorecard };
  