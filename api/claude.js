const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'cricbuzz-cricket.p.rapidapi.com';
const BASE = 'https://cricbuzz-cricket.p.rapidapi.com';

async function cbFetch(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
      'Content-Type': 'application/json'
    }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cricbuzz ${r.status}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, matchId } = req.body;

  try {
    // ── ACTION: get live/upcoming IPL matches ─────────────────────────────
    if (action === 'live_matches') {
      // Fetch live matches + upcoming schedule
      const [liveData, upcomingData] = await Promise.all([
        cbFetch('/matches/v1/live'),
        cbFetch('/matches/v1/upcoming')
      ]);

      const parseMatches = (data, status) => {
        const matches = [];
        const types = data?.typeMatches || [];
        for (const t of types) {
          for (const series of (t.seriesMatches || [])) {
            const sm = series.seriesAdWrapper || series;
            for (const m of (sm.matches || [])) {
              const mi = m.matchInfo;
              if (!mi) continue;
              // Filter only IPL
              if (!mi.seriesName?.toLowerCase().includes('ipl') &&
                  !mi.seriesName?.toLowerCase().includes('indian premier')) continue;
              matches.push({
                id: String(mi.matchId),
                num: mi.matchDesc?.replace(/\D/g,'') || mi.matchId,
                team1: mi.team1?.teamSName || mi.team1?.teamName,
                team2: mi.team2?.teamSName || mi.team2?.teamName,
                date: new Date(parseInt(mi.startDate)).toISOString().split('T')[0],
                time: new Date(parseInt(mi.startDate)).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'Asia/Kolkata'}),
                venue: mi.venueInfo?.ground + ', ' + mi.venueInfo?.city || 'TBD',
                status,
                cbMatchId: String(mi.matchId)
              });
            }
          }
        }
        return matches;
      };

      const live = parseMatches(liveData, 'live');
      const upcoming = parseMatches(upcomingData, 'upcoming');

      return res.status(200).json({ matches: [...live, ...upcoming] });
    }

    // ── ACTION: get playing XI ────────────────────────────────────────────
    if (action === 'playing11') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });
      const data = await cbFetch(`/mcenter/v1/${matchId}/playing11`);

      const parseXI = (team) => {
        return (team?.players || []).map(p => ({
          name: p.fullName || p.name,
          role: mapRole(p.role)
        }));
      };

      const xi1 = parseXI(data?.players?.['1'] || data?.team1);
      const xi2 = parseXI(data?.players?.['2'] || data?.team2);

      // Also try flat structure
      const allPlayers = data?.players || [];
      let t1 = [], t2 = [];
      if (Array.isArray(allPlayers)) {
        // flat array with teamId
        const teamIds = [...new Set(allPlayers.map(p => p.teamId))];
        t1 = allPlayers.filter(p => p.teamId === teamIds[0]).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
        t2 = allPlayers.filter(p => p.teamId === teamIds[1]).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
      }

      return res.status(200).json({
        confirmed: true,
        xi1: xi1.length ? xi1 : t1,
        xi2: xi2.length ? xi2 : t2,
        raw: data // send raw so frontend can debug if needed
      });
    }

    // ── ACTION: get scorecard ─────────────────────────────────────────────
    if (action === 'scorecard') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });
      const data = await cbFetch(`/mcenter/v1/${matchId}/hscard`);

      const players = {};
      const matchScore = extractScore(data);
      const status = data?.matchHeader?.state === 'Complete' ? 'completed' : 
                     data?.matchHeader?.state === 'In Progress' ? 'live' : 'upcoming';

      // Parse batting from all innings
      const innings = data?.scoreCard || [];
      for (const inn of innings) {
        for (const bat of (inn.batTeamDetails?.batsmanData ? Object.values(inn.batTeamDetails.batsmanData) : [])) {
          const name = bat.batName;
          if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].runs += bat.runs || 0;
        }
        // Parse bowling
        for (const bowl of (inn.bowlTeamDetails?.bowlersData ? Object.values(inn.bowlTeamDetails.bowlersData) : [])) {
          const name = bowl.bowlName;
          if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].wickets += bowl.wickets || 0;
        }
      }

      return res.status(200).json({ players, matchScore, status });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function mapRole(role) {
  if (!role) return 'BAT';
  const r = role.toLowerCase();
  if (r.includes('keeper') || r.includes('wk') || r.includes('wicket')) return 'WK';
  if (r.includes('allrounder') || r.includes('all-rounder') || r.includes('batting all') || r.includes('bowling all')) return 'AR';
  if (r.includes('bowl')) return 'BOWL';
  return 'BAT';
}

function extractScore(data) {
  try {
    const h = data?.matchHeader;
    const s = data?.miniscore;
    if (s) {
      return `${s.batTeam?.teamScore || ''} — ${s.bowlTeam?.teamScore || ''}`;
    }
    return h?.status || 'Score unavailable';
  } catch { return 'Score unavailable'; }
}
