const KEY = process.env.RAPIDAPI_KEY;
const HOST = 'cricbuzz-cricket.p.rapidapi.com';
const BASE = `https://${HOST}`;

async function cb(path) {
  const url = `${BASE}/${path}`;
  const r = await fetch(url, {
    headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`CB ${r.status} ${path}: ${text.slice(0,200)}`);
  try { return JSON.parse(text); }
  catch(e) { throw new Error(`Bad JSON from ${path}`); }
}

function mapRole(role) {
  if (!role) return 'BAT';
  const r = role.toLowerCase();
  if (r.includes('keeper') || r.includes('wk')) return 'WK';
  if (r.includes('all')) return 'AR';
  if (r.includes('bowl')) return 'BOWL';
  return 'BAT';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, matchId, seriesId } = req.body;

  try {

    // ── GET IPL MATCH IDs from series ─────────────────────────────────────
    if (action === 'sync_matches') {
      // Get recent + upcoming series list to find IPL
      const [recent, upcoming] = await Promise.allSettled([
        cb('matches/recent'),
        cb('matches/upcoming')
      ]);

      const allMatches = [];
      for (const result of [recent, upcoming]) {
        if (result.status !== 'fulfilled') continue;
        for (const type of (result.value.typeMatches || [])) {
          for (const series of (type.seriesMatches || [])) {
            const sw = series.seriesAdWrapper;
            if (!sw) continue;
            const isIPL = (sw.seriesName||'').toLowerCase().includes('ipl') ||
                          (sw.seriesName||'').toLowerCase().includes('indian premier');
            for (const m of (sw.matches || [])) {
              const mi = m.matchInfo;
              if (!mi) continue;
              allMatches.push({
                matchId: String(mi.matchId),
                seriesId: String(mi.seriesId),
                seriesName: sw.seriesName,
                isIPL,
                team1: mi.team1?.teamSName,
                team2: mi.team2?.teamSName,
                state: mi.state,
                startDate: mi.startDate
              });
            }
          }
        }
      }

      return res.status(200).json({ matches: allMatches });
    }

    // ── GET SQUADS FOR A SERIES (used as player pool) ─────────────────────
    if (action === 'squads') {
      if (!seriesId) return res.status(400).json({ error: 'seriesId required' });
      const data = await cb(`series/get-squads?seriesId=${seriesId}`);
      return res.status(200).json(data);
    }

    // ── GET MATCH INFO (has playing XI after toss) ────────────────────────
    if (action === 'match_info') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });
      const data = await cb(`matches/get-info?matchId=${matchId}`);

      // Extract playing XI from matchInfo if available
      let xi1 = [], xi2 = [];
      const squads = data.matchInfo?.squads || data.squads || [];

      for (const squad of squads) {
        const players = (squad.players || []).map(p => ({
          name: p.fullName || p.name,
          role: mapRole(p.role)
        }));
        if (xi1.length === 0) xi1 = players;
        else xi2 = players;
      }

      // Also check team1/team2 playing11 fields
      const p11 = data.matchInfo?.playingXI || data.playingXI;
      if (p11) {
        xi1 = (p11.team1 || []).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
        xi2 = (p11.team2 || []).map(p => ({ name: p.fullName || p.name, role: mapRole(p.role) }));
      }

      const confirmed = xi1.length >= 10 && xi2.length >= 10;
      return res.status(200).json({ confirmed, xi1, xi2, raw: data });
    }

    // ── GET SCORECARD ─────────────────────────────────────────────────────
    if (action === 'scorecard') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });

      let data;
      try {
        data = await cb(`matches/get-scorecard?matchId=${matchId}`);
      } catch(e) {
        data = await cb(`matches/get-scorecard-v2?matchId=${matchId}`);
      }

      const players = {};
      let matchScore = '';
      let status = 'upcoming';

      // Match status
      const header = data.matchHeader || {};
      matchScore = header.status || '';
      const state = (header.state || '').toLowerCase();
      if (state.includes('progress')) status = 'live';
      else if (state.includes('complete') || header.complete) status = 'completed';

      // Parse innings
      const innings = data.scoreCard || [];
      for (const inn of innings) {
        // Batting
        const batData = inn.batTeamDetails?.batsmanData || {};
        for (const bat of Object.values(batData)) {
          const name = bat.batName;
          if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].runs += parseInt(bat.runs) || 0;
        }
        // Bowling
        const bowlData = inn.bowlTeamDetails?.bowlersData || {};
        for (const bowl of Object.values(bowlData)) {
          const name = bowl.bowlName;
          if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].wickets += parseInt(bowl.wickets) || 0;
        }
        // Build score string
        const sd = inn.scoreDetails || {};
        const teamName = inn.batTeamDetails?.batTeamName || '';
        if (teamName) matchScore = matchScore || `${teamName} ${sd.runs||0}/${sd.wickets||0} (${sd.overs||0} ov)`;
      }

      return res.status(200).json({ players, matchScore, status });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
