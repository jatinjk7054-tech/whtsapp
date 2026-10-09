import { sql } from '../config/db.js';
import { getSetting } from '../models/settingsModel.js';
import { parseRosterSetting, shapeTeamCollection, NO_TEAM_KEY } from '../utils/teamCollection.js';
import { istDateString, istMonthKey } from '../utils/ist.js';

// Single source of truth for the team-wise collection board.
//
// Two panels render this same board: the NGO-admin dashboard header (against the
// global date/NGO/FRO filter) and the FRO panel's Collection Race popup. Both call
// this module rather than each carrying their own copy of the SQL, because the one
// thing that would make the feature look broken is the same board showing two
// different totals in two places on the same screen.
//
// The receipt -> fro_donor_logs -> fro_assignments chain and the IST boundary
// conversion match getStationWiseCollection / getTLDashboard's
// `collections_per_ngo` on purpose. The Collection card LEFT JOINs those two tables
// but filters `WHERE fa.ngo_id = ANY(...)`, and NULL is never `= ANY(...)`, so
// those LEFT JOINs behave as inner joins - meaning the inner joins here select the
// same receipt set and this board's total reconciles with the Collection card.
//
// `workers` is LEFT joined, unlike the Collection card, because this board needs a
// column it does not have. An inner join there would DROP any receipt whose
// fro_worker_id no longer has a `workers` row, and the board would then quietly read
// lower than the Collection card with no visible cause. Left joining keeps the
// money, and that FRO's share lands in the No Team bucket, which the card footnotes
// - so an unassigned amount is explained rather than missing.
//
// The roster (which teams exist) comes from the `collection_teams` setting, NOT from
// the GROUP BY. Accounts > Teams can add / rename / remove teams at runtime, and a
// team that collected nothing in this window produces no aggregate row at all - so
// deriving the board from the data alone would make teams vanish off the
// leaderboard on a slow day, which is exactly when it is being watched.
// utils/teamCollection.js owns the shaping and its invariants.

const ROSTER_KEY = 'collection_teams';

// Guards the roster read so a dashboard polled by several admins does not hit
// `settings` once per user per filter change. The row only changes when someone
// edits Accounts > Teams, so a short TTL keeps it off the hot path entirely.
let _rosterCache = { at: 0, roster: null };
const ROSTER_TTL_MS = 30_000;

export async function getTeamRoster() {
  const now = Date.now();
  if (_rosterCache.roster && now - _rosterCache.at < ROSTER_TTL_MS) return _rosterCache.roster;
  let roster = parseRosterSetting(null);
  try {
    roster = parseRosterSetting(await getSetting(ROSTER_KEY));
  } catch {
    // A missing or unreadable settings row must not take the leaderboard down;
    // parseRosterSetting(null) yields the documented default set.
    roster = parseRosterSetting(null);
  }
  _rosterCache = { at: now, roster };
  return roster;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// A shape check alone is not enough: "2026-13-40" matches ^\d{4}-\d{2}-\d{2}$ but is
// not a date, and it goes straight into `$1::date` - where Postgres raises, turning a
// bad query parameter into a 500 instead of the 400 the caller deserves. So the parts
// are re-assembled and compared back, which rejects overflow dates like 2026-02-30 as
// well as impossible months.
function isRealDay(value) {
  const s = String(value ?? '');
  if (!DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Normalises the date window. `strict` decides what a missing from/to means:
// the admin endpoint requires them (the global filter always supplies both, and a
// silent default would hide a client bug), while a filter-less caller defaults to
// today.
export function resolveRange({ from, to, strict = true }) {
  // istDateString, not toISOString(): the server may run in any timezone, and the
  // board's day boundaries are IST ones (see the AT TIME ZONE clauses below).
  const today = istDateString();
  let f = String(from || '').trim();
  let t = String(to || '').trim();
  if (strict && (!isRealDay(f) || !isRealDay(t))) return null;
  if (!isRealDay(f)) f = today;
  if (!isRealDay(t)) t = f;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

/**
 * @param from,to   'YYYY-MM-DD', already resolved through resolveRange
 * @param ngoIds    restrict to these NGOs. Omit / empty for org-wide, which is what
 *                  the FRO popup uses - an FRO has no NGO access list to scope by,
 *                  and the existing org-wide FRO leaderboards set that precedent.
 * @param froId     restrict to one workers.id
 * @param youTeam   the viewer's own team, to flag its lane as `is_you`
 */
export async function buildTeamCollection({ from, to, ngoIds, froId, youTeam } = {}) {
  const roster = await getTeamRoster();

  // WHERE is assembled with positional params rather than fixed $3/$4 with NULL
  // branches: the fro_id filter has to be genuinely absent rather than
  // "= ANY(NULL)", and appending keeps the numbering correct without cast guessing.
  const where = [
    "r.receipt_date >= ($1::date AT TIME ZONE 'Asia/Kolkata')",
    "r.receipt_date <  (($2::date + 1) AT TIME ZONE 'Asia/Kolkata')",
  ];
  const params = [from, to];
  if (Array.isArray(ngoIds) && ngoIds.length > 0) {
    params.push(ngoIds);
    where.push(`fa.ngo_id = ANY($${params.length}::uuid[])`);
  }
  if (froId) {
    params.push([String(froId)]);
    where.push(`l.fro_worker_id = ANY($${params.length}::uuid[])`);
  }
  const rowsSql = `WHERE ${where.join('\n          AND ')}`;

  // Team identity, normalised in SQL rather than in JS. `workers.team` is free text
  // while normalizeRoster upper-cases the roster, so "ufs1" and "UFS1" are the SAME
  // team - but a raw `btrim` key would miss the roster lane and that person's money
  // would appear twice on the board: once under UFS1, once as a separate
  // "unrostered" lane. UPPER here is what keeps one team to one lane.
  // Blank/nullable collapses to the No Team sentinel, which is never a lane.
  const teamKeySql = `COALESCE(NULLIF(UPPER(btrim(w.team)), ''), '${NO_TEAM_KEY}')`;

  const teamSql = `
        SELECT ${teamKeySql} AS team_key,
                COALESCE(SUM(r.amount), 0) AS total,
                COUNT(*)::int AS receipts,
                COUNT(DISTINCT l.fro_worker_id)::int AS members
           FROM receipts r
           JOIN fro_donor_logs l   ON l.id = r.log_id
           JOIN fro_assignments fa ON fa.id = l.assignment_id
           LEFT JOIN workers w     ON w.id = l.fro_worker_id
        ${rowsSql}
        GROUP BY 1`;
  // One row per (team, FRO) so the card can credit a person, not just a code. No
  // member cap: the shaping step picks one top FRO per team, so these rows are
  // bounded by headcount anyway.
  const froSql = `
        SELECT ${teamKeySql} AS team_key,
                l.fro_worker_id,
                w.name,
                COALESCE(SUM(r.amount), 0) AS total
           FROM receipts r
           JOIN fro_donor_logs l   ON l.id = r.log_id
           JOIN fro_assignments fa ON fa.id = l.assignment_id
           LEFT JOIN workers w     ON w.id = l.fro_worker_id
        ${rowsSql}
        GROUP BY 1, 2, 3`;

  // Both queries share one WHERE, so team totals and the top-FRO credits are always
  // drawn from the same receipt set and cannot disagree with each other.
  const [teamRows, froRows] = await Promise.all([sql(teamSql, params), sql(froSql, params)]);

  const board = shapeTeamCollection({ roster, teamRows, froRows });

  // Flag the viewer's own lane. Compared against the shaped rows rather than done in
  // the client because this is where both sides are already in normalised
  // upper-case form; a viewer whose team is not on the board (or who has none) simply
  // gets no flag instead of a highlight pointing at a lane that does not exist.
  const mine = youTeam ? String(youTeam).trim().toUpperCase() : '';
  for (const t of board.teams) {
    t.is_you = !!mine && t.team === mine;
  }

  return { from, to, roster, you_team: mine || null, ...board };
}

// The team a worker belongs to, in the same normalised key form the board's rows use,
// so it can be compared to a `teams[].team` value without re-normalising.
// Returns null for "no team" - there is no No Team lane to highlight, and claiming
// otherwise would make the caller highlight nothing while thinking it had.
export async function getWorkerTeamKey(workerId) {
  if (!workerId) return null;
  const rows = await sql(
    `SELECT COALESCE(NULLIF(UPPER(btrim(team)), ''), '${NO_TEAM_KEY}') AS team_key
       FROM workers WHERE id = $1::uuid LIMIT 1`,
    [workerId],
  );
  const key = String(rows?.[0]?.team_key ?? '');
  if (!key || key === NO_TEAM_KEY) return null;
  return key;
}

// The FRO popup's filter. Resolved here rather than in the browser because these are
// IST day boundaries and the server is the only place that knows "today" for the org
// - a client in another timezone would silently shift the window by a day.
export const PERIODS = ['today', 'week', 'month'];

export const PERIOD_LABELS = { today: 'Today', week: 'This week', month: 'This month' };

export function resolvePeriodRange(period) {
  const today = istDateString();
  const p = String(period || '').trim().toLowerCase();
  if (p === 'week') {
    // Rolling 7 days including today, done on a plain YYYY-MM-DD string via UTC
    // methods so no local timezone can shift the boundary.
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 6);
    return { from: end.toISOString().slice(0, 10), to: today };
  }
  if (p === 'month') return { from: `${istMonthKey()}-01`, to: today };
  return { from: today, to: today };
}
