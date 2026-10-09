import { getSetting, upsertSetting } from '../models/settingsModel.js';

const DEFAULT_TEAMS = ['UFS1', 'UFS2', 'UFS3', 'UFS4'];
const TEAM_KEY = 'collection_teams';

const normalizeTeams = (list) => {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const name = String(t ?? '').trim().toUpperCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
};

// GET /api/teams -> { teams: [...] }
// Stored in the settings table (JSON array). Defaults to UFS1-UFS4 when unset.
export const getTeams = async (req, res) => {
  try {
    const raw = await getSetting(TEAM_KEY);
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      return res.json({ teams: [...DEFAULT_TEAMS] });
    }
    let teams = [];
    try {
      teams = JSON.parse(raw);
    } catch (e) {
      teams = [];
    }
    return res.json({ teams: normalizeTeams(teams) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// PUT /api/teams { teams: [...] } -> persists the full list
export const putTeams = async (req, res) => {
  try {
    const teams = normalizeTeams(req.body?.teams);
    await upsertSetting(TEAM_KEY, JSON.stringify(teams));
    return res.json({ teams });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};