const KEY = process.env.RAPIDAPI_KEY;
const HOST = 'cricbuzz-cricket.p.rapidapi.com';
const BASE = `https://${HOST}`;

async function cb(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      'x-rapidapi-key': KEY,
      'x-rapidapi-host': HOST
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`CB ${r.status}: ${text.slice(0,300)}`);
  try { return JSON.parse(text); }
  catch(e) { throw new Error(`Bad JSON from ${path}: ${text.slice(0,100)}`); }
}

// Parse all matches from typeMatches response structure
function parseMatchesFromResponse(data) {
  const matches = [];
  for (const type of (data.typeMatches || [])) {
    for (const series of (type.seriesMatches || [])) {
      const sw = series.seriesAdWrapper;
      if (!sw) continue;
      const sName = sw.seriesName || '';
      const isIPL = sName.toLowerCase().includes('ipl') ||
                    sName.toLowerCase().includes('indian premier');
      for (const m of (sw.matches || [])) {
        const mi = m.matchInfo;
        if (!mi) continue;
        matches.push({
          matchId: String(mi.matchId),
          seriesId: String(mi.seriesId),
          seriesName: sName,
          isIPL,
          desc: mi.matchDesc,
          format: mi.matchFormat,
          state: mi.state,
          status: mi.status,
          startDate: mi.startDate,
          team1: mi.team1?.teamSName || mi.team1?.teamName,
          team2: mi.team2?.teamSName || mi.team2?.teamName,
          team1Full: mi.team1?.teamName,
          team2Full: mi.team2?.teamName,
          venue: `${mi.venueInfo?.ground || ''}, ${mi.venueInfo?.city || ''}`.trim().replace(/^,|,$/g,''),
        });
      }
    }
  }
  return matches;
}

function toStatus(state) {
  if (!state) return 'upcoming';
  const s = state.toLowerCase();
  if (s.includes('progress') || s.includes('live')) return 'live';
  if (s.includes('complete') || s.includes('won') || s.includes('drawn') || s.includes('tied')) return 'done';
  return 'upcoming';
}

function mapRole(role) {
  if (!role) return 'BAT';
  const r = role.toLowerCase();
  if (r.includes('keeper') || r.includes('wk') || r.includes('wicket')) return 'WK';
  if (r.includes('allrounder') || r.includes('all-rounder') || r.includes('all rounder')) return 'AR';
  if (r.includes('bowl')) return 'BOWL';
  return 'BAT';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, matchId } = req.body;

  try {

    // ── SYNC: find IPL match IDs from live+recent+upcoming ────────────────
    if (action === 'sync_matches') {
      const [live, recent, upcoming] = await Promise.allSettled([
        cb('/matches/v1/live'),
        cb('/matches/v1/recent'),
        cb('/matches/v1/upcoming')
      ]);

      const all = [];
      for (const r of [live, recent, upcoming]) {
        if (r.status === 'fulfilled') {
          all.push(...parseMatchesFromResponse(r.value));
        }
      }

      // Deduplicate by matchId
      const seen = new Set();
      const unique = all.filter(m => {
        if (seen.has(m.matchId)) return false;
        seen.add(m.matchId);
        return true;
      });

      // Return all matches, flagged if IPL
      return res.status(200).json({ matches: unique });
    }

    // ── PLAYING XI ────────────────────────────────────────────────────────
    if (action === 'playing11') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });

      const data = await cb(`/mcenter/v1/${matchId}/playing11`);

      // Response structure: { team1: { players: [...] }, team2: { players: [...] } }
      // OR: { teams: [ { teamId, players: [...] }, ... ] }
      let xi1 = [], xi2 = [];

      if (data.team1?.players) {
        xi1 = data.team1.players.map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
        xi2 = (data.team2?.players || []).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
      } else if (Array.isArray(data.teams)) {
        xi1 = (data.teams[0]?.players || []).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
        xi2 = (data.teams[1]?.players || []).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
      } else if (data.players) {
        // flat array — split by teamId
        const players = Array.isArray(data.players) ? data.players : Object.values(data.players);
        const teamIds = [...new Set(players.map(p => p.teamId))];
        xi1 = players.filter(p => p.teamId === teamIds[0]).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
        xi2 = players.filter(p => p.teamId === teamIds[1]).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
      }

      const confirmed = xi1.length >= 10 && xi2.length >= 10;
      console.log(`XI: ${xi1.length} + ${xi2.length} players, confirmed: ${confirmed}`);
      return res.status(200).json({ confirmed, xi1, xi2 });
    }

    // ── SCORECARD ─────────────────────────────────────────────────────────
    if (action === 'scorecard') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });

      // Try live scorecard first, fall back to full scorecard
      let data;
      try {
        data = await cb(`/mcenter/v1/${matchId}/scard`);
      } catch(e) {
        data = await cb(`/mcenter/v1/${matchId}/hscard`);
      }

      const players = {};
      let matchScore = '';
      let status = 'upcoming';

      // Parse match header
      const header = data.matchHeader || data.matchHdr;
      if (header) {
        matchScore = header.status || '';
        const state = (header.state || '').toLowerCase();
        if (state.includes('progress')) status = 'live';
        else if (state.includes('complete') || header.complete) status = 'completed';
      }

      // Parse scorecard innings
      const innings = data.scoreCard || data.scorecard || [];
      for (const inn of innings) {
        // Batting
        const batData = inn.batTeamDetails?.batsmanData || inn.batsmen || {};
        const batArr = Array.isArray(batData) ? batData : Object.values(batData);
        for (const bat of batArr) {
          const name = bat.batName || bat.name || bat.fullName;
          if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].runs += parseInt(bat.runs) || 0;
        }
        // Bowling
        const bowlData = inn.bowlTeamDetails?.bowlersData || inn.bowlers || {};
        const bowlArr = Array.isArray(bowlData) ? bowlData : Object.values(bowlData);
        for (const bowl of bowlArr) {
          const name = bowl.bowlName || bowl.name || bowl.fullName;
          if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].wickets += parseInt(bowl.wickets) || 0;
        }
      }

      // Build score string from innings
      if (!matchScore && innings.length) {
        matchScore = innings.map(inn => {
          const t = inn.batTeamDetails?.batTeamName || inn.teamName || '';
          const s = inn.scoreDetails || inn.score || {};
          return `${t} ${s.runs || 0}/${s.wickets || 0} (${s.overs || 0} ov)`;
        }).join(' | ');
      }

      return res.status(200).json({ players, matchScore, status });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
