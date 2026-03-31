const KEY = process.env.RAPIDAPI_KEY;
const HOST = 'cricbuzz-cricket.p.rapidapi.com';
const BASE = `https://${HOST}`;

async function cb(path) {
  const r = await fetch(`${BASE}/${path}`, {
    headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`CB ${r.status} /${path}: ${text.slice(0,200)}`);
  try { return JSON.parse(text); }
  catch(e) { throw new Error(`Bad JSON from /${path}`); }
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

    // ── SYNC: find IPL match IDs ──────────────────────────────────────────
    if (action === 'sync_matches') {
      const results = await Promise.allSettled([
        cb('matches/v1/live'),
        cb('matches/v1/recent'),
        cb('matches/v1/upcoming')
      ]);
      const allMatches = [];
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const type of (r.value.typeMatches || [])) {
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
              });
            }
          }
        }
      }
      return res.status(200).json({ matches: allMatches });
    }

    // ── SQUADS: get full squad for a series ─────────────────────────────
    if (action === 'squads') {
      if (!seriesId) return res.status(400).json({ error: 'seriesId required' });

      const data = await cb(`series/get-squads?seriesId=${seriesId}`);
      console.log('squads raw keys:', Object.keys(data));

      const squads = [];

      // Response shape 1: { squads: [ { squad: { player: [...] }, team: {...} } ] }
      for (const entry of (data.squads || [])) {
        const team = entry.team || {};
        const players = (entry.squad?.player || entry.player || []).map(p => ({
          name: p.fullName || p.name,
          role: mapRole(p.role)
        }));
        if (players.length) squads.push({ teamName: team.teamName, teamSName: team.teamSName, players });
      }

      // Response shape 2: top-level squads array with different structure
      if (!squads.length && data.squadDetails) {
        for (const sd of (data.squadDetails || [])) {
          const players = (sd.squadItems || []).map(p => ({
            name: p.player?.fullName || p.player?.name || p.name,
            role: mapRole(p.player?.role || p.role)
          }));
          if (players.length) squads.push({ teamName: sd.teamName, teamSName: sd.teamSName, players });
        }
      }

      return res.status(200).json({ squads, _raw: data });
    }

    // ── SCORECARD: mcenter/v1/{matchId}/hscard ────────────────────────────
    if (action === 'scorecard') {
      if (!matchId) return res.status(400).json({ error: 'matchId required' });
      // Try live scard first, fall back to hscard
      let data;
      try { data = await cb(`mcenter/v1/${matchId}/scard`); }
      catch(e) { data = await cb(`mcenter/v1/${matchId}/hscard`); }

      const players = {};
      let matchScore = '';
      let status = 'upcoming';

      const header = data.matchHeader || {};
      matchScore = header.status || '';
      const state = (header.state || '').toLowerCase();
      if (state === 'in progress') status = 'live';
      else if (state === 'complete') status = 'completed';

      for (const inn of (data.scoreCard || [])) {
        // Batting
        for (const bat of Object.values(inn.batTeamDetails?.batsmanData || {})) {
          const name = bat.batName; if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].runs += parseInt(bat.runs) || 0;
        }
        // Bowling
        for (const bowl of Object.values(inn.bowlTeamDetails?.bowlersData || {})) {
          const name = bowl.bowlName; if (!name) continue;
          if (!players[name]) players[name] = { runs: 0, wickets: 0 };
          players[name].wickets += parseInt(bowl.wickets) || 0;
        }
        // Score string
        const sd = inn.scoreDetails || {};
        const tn = inn.batTeamDetails?.batTeamName || '';
        if (tn && sd.runs !== undefined) {
          matchScore = `${tn} ${sd.runs}/${sd.wickets} (${sd.overs} ov)`;
        }
      }

      return res.status(200).json({ players, matchScore, status });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
