// Team-wise collection shaping for the NGO-admin racing card.
//
// The team roster is a settings row (`collection_teams`, see teamController.js),
// NOT a constant: Accounts > Teams can add, rename and remove teams at any time,
// and a rename back-fills `workers.team` for the team's members. UFS1-UFS4 are
// only the fallback used when that row has never been written.
//
// That is why the roster is an input here rather than something derived from the
// collection data. Building the board from the receipts alone would silently DROP
// any configured team that collected nothing in the selected range, so a team
// would vanish off the leaderboard on a slow day and reappear when it collected
// again. Every roster entry is therefore emitted at zero and overlaid with the
// aggregates, which is what keeps the board stable and the race honest.
//
// Three buckets come out of this, and they are deliberately different:
//
//   1. Roster teams        - the configured teams, always present, sorted by
//                           amount with ties broken by roster position (the
//                           insertion order Teams.jsx preserves, i.e. the
//                           seed -> UFS5 progression) rather than alphabetically.
//   2. No Team             - receipts whose FRO has no team set. Real money, but
//                           the card does not put it on the race; it is reported
//                           separately so the caller can footnote it.
//   3. Unrostered teams    - a `workers.team` value that is NOT in the roster,
//                           e.g. rows a rename missed. Kept as its own row and
//                           flagged, because dropping it would make this endpoint's
//                           total disagree with the Collection card above it.
//
// Kept dependency-free and pure so it is unit-testable without a database.

export const NO_TEAM_KEY = '__none';
export const NO_TEAM_LABEL = 'No Team';

// Fallback roster. Only used when the `collection_teams` setting is absent or
// unparseable - identical to teamController.js / useTeams.js so the two never
// disagree about what the default set of teams is.
export const DEFAULT_TEAMS = ['UFS1', 'UFS2', 'UFS3', 'UFS4'];

export const teamLabel = (key) => (key === NO_TEAM_KEY ? NO_TEAM_LABEL : String(key));

// Case-folded, trimmed, deduped roster - same rules teamController.normalizeTeams
// applies on write, so a hand-edited settings row cannot smuggle in "ufs1" as a
// second team distinct from "UFS1".
export function normalizeRoster(list) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const name = String(t ?? '').trim().toUpperCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Parses the raw settings value. Falls back to the defaults for anything
// unusable, since a corrupt row must not take the leaderboard down.
export function parseRosterSetting(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return [...DEFAULT_TEAMS];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_TEAMS];
  }
  const roster = normalizeRoster(parsed);
  return roster.length > 0 ? roster : [...DEFAULT_TEAMS];
}

// Order key for a team LABEL, used only as the tie-break between equal amounts.
// Reads the trailing digits of a "UFS<N>" style name so UFS9 sorts before UFS10;
// a plain string compare would get that backwards and shuffle the podium. Names
// with no trailing number sort after every numbered team, alphabetically.
export function teamSortRank(label) {
  const name = String(label || '').trim().toUpperCase();
  const m = name.match(/^([A-Z]*\s*)(\d+)$/);
  if (m) return { prefix: m[1], num: Number(m[2]), name };
  return { prefix: name, num: Number.MAX_SAFE_INTEGER, name };
}

export function compareTeamLabels(a, b) {
  const ra = teamSortRank(a);
  const rb = teamSortRank(b);
  if (ra.prefix !== rb.prefix) return ra.prefix < rb.prefix ? -1 : 1;
  if (ra.num !== rb.num) return ra.num - rb.num;
  return ra.name < rb.name ? -1 : ra.name > rb.name ? 1 : 0;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round(n * 100) / 100;

// teamRows / froRows are the raw aggregates, each carrying `team_key`:
//   teamRows: [{ team_key, total, receipts, members }]
//   froRows:  [{ team_key, fro_worker_id, name, total }]
//
// Returns:
//   { teams, unassigned, total, unrostered_count }
//
// `teams` is the race board: one entry per roster team (zero-filled) plus one per
// unrostered value, ordered by amount desc with roster position as the tie-break.
// `unassigned` holds the No Team bucket, excluded from `teams` and from `total`.
export function shapeTeamCollection({ roster, teamRows, froRows }) {
  const rosterList = normalizeRoster(roster);
  const rosterIndex = new Map(rosterList.map((name, i) => [name, i]));

  // Seed every roster team so the board always has the same set of lanes.
  const byKey = new Map();
  for (const name of rosterList) {
    byKey.set(name, { team: name, amount: 0, receipts: 0, members: 0, unrostered: false, top_fro: null });
  }

  let unassignedAmount = 0;
  let unassignedReceipts = 0;

  for (const row of teamRows || []) {
    const key = String(row?.team_key ?? '');
    if (!key) continue;
    const amount = round2(num(row.total));
    const receipts = num(row.receipts);
    if (key === NO_TEAM_KEY) {
      unassignedAmount += amount;
      unassignedReceipts += receipts;
      continue;
    }
    const entry = byKey.get(key) || { team: key, amount: 0, receipts: 0, members: 0, unrostered: true, top_fro: null };
    entry.amount += amount;
    entry.receipts += receipts;
    // A duplicate key can only come from an already-merged GROUP BY, but summing
    // members as well keeps the row self-consistent if that ever changes.
    entry.members = Math.max(entry.members, num(row.members));
    byKey.set(key, entry);
  }

  // Highest-collecting FRO per team, so the card can credit a person and not just
  // a team code. Ties fall back to name so the pick is deterministic.
  for (const row of froRows || []) {
    const key = String(row?.team_key ?? '');
    if (!key || key === NO_TEAM_KEY) continue;
    const entry = byKey.get(key);
    if (!entry) continue;
    const amount = round2(num(row.total));
    if (!entry.top_fro || amount > entry.top_fro.amount
      || (amount === entry.top_fro.amount && String(row.name || '') < String(entry.top_fro.name || ''))) {
      entry.top_fro = { id: row.fro_worker_id ?? null, name: String(row.name || 'Unknown'), amount };
    }
  }

  const teams = [...byKey.values()];
  // Sort position: roster teams by their configured index, unrostered ones last.
  const positionOf = (t) => (rosterIndex.has(t.team) ? rosterIndex.get(t.team) : Number.MAX_SAFE_INTEGER);
  teams.sort((a, b) => (
    b.amount - a.amount
    || positionOf(a) - positionOf(b)
    || compareTeamLabels(a.team, b.team)
  ));

  // Share is measured against the raced total (No Team is not on the board), so
  // the percentages of the bars add to 100.
  const total = round2(teams.reduce((s, t) => s + t.amount, 0));
  for (const t of teams) {
    t.share = total > 0 ? Math.round((t.amount / total) * 1000) / 10 : 0;
  }

  return {
    teams,
    unassigned: { amount: round2(unassignedAmount), receipts: unassignedReceipts },
    total,
    unrostered_count: teams.filter((t) => t.unrostered).length,
  };
}