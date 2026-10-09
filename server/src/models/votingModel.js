import crypto from 'crypto';
import db from '../config/db.js';

const DEPTS_TABLE = 'voting_departments';
const MEMBERS_TABLE = 'voting_department_members';
const SESSIONS_TABLE = 'voting_sessions';
const TURNS_TABLE = 'voting_turns';
const BALLOTS_TABLE = 'voting_ballots';
const AUDIT_TABLE = 'voting_audit';

// Ballot anonymity depends on this value never leaving the server, so it is read
// from the environment and never returned through any endpoint. JWT_SECRET is a
// last-resort fallback only; a dedicated salt should be set in production.
function ballotSecret() {
  return String(process.env.VOTING_BALLOT_SALT || process.env.JWT_SECRET || 'voting-dev-salt');
}

/** Department names are free text in this codebase; compare them case/whitespace-insensitively. */
export const normDept = (v) => String(v ?? '').trim().toLowerCase();

/** Team names are free text for the same reason, and `workers.team` is nullable. */
export const normTeam = (v) => String(v ?? '').trim().toLowerCase();

/**
 * What order two team groups render in: named teams first, in name order.
 *
 * Numeric-aware so UFS2 sorts before UFS10 rather than after it.
 */
const TEAM_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byTeamLabel = (a, b) => {
  if (a.key === b.key) return 0;
  if (!a.key) return 1;
  if (!b.key) return -1;
  return TEAM_COLLATOR.compare(a.label, b.label);
};

/**
 * Group a roster by worker team, because the team is the ballot's unit of choice.
 *
 * One pick per team means the teams are the ballot's real structure: a
 * department with four teams is four picks, not one.
 *
 * Two rules, both about who is actually votable:
 *
 *   - Someone with no team assigned is not on the ballot at all. Putting them in
 *     a "No team" section made them a team nobody is on, so they could win a
 *     prize nobody chose them for. They are instead fixed by giving them a team
 *     in the HR picker.
 *   - If a roster has teams *and* unassigned people, that leaves a real ballot.
 *     But if a whole department has no teams at all, dropping its people would
 *     leave nobody votable there and the department could never produce a
 *     winner — so it falls back to a single group holding everyone, which is
 *     exactly how a one-team ballot behaved before.
 *
 * Returns `[{ key, label, members }]`. The key is the normalised team and is what
 * ballots are stored against; the label is the text as HR typed it, or
 * `fallbackLabel` for that single-group case.
 */
export const groupByTeam = (people = [], { fallbackLabel = '' } = {}) => {
  const byKey = new Map();
  for (const p of people) {
    const label = String(p?.team ?? '').trim();
    const key = normTeam(label);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, label, members: [] });
    byKey.get(key).members.push(p);
  }

  const groups = [...byKey.values()];
  if (!groups.length && people.length) {
    groups.push({ key: '', label: String(fallbackLabel || '').trim(), members: [...people] });
  }
  return groups.sort(byTeamLabel);
};

/**
 * Does a worker's department fall into a group's match list?
 *
 * match_department is a comma/newline-separated list (e.g. HR's matches both the
 * `HR` and `HR-Recruiter` values that exist in the worker dropdown), so a group
 * can span several department labels without asking HR to hand-pick people.
 */
export const deptMatches = (value, workerDepartment) => {
  const wanted = normDept(workerDepartment);
  return String(value ?? '')
    .split(/[,|\n]/)
    .map(normDept)
    .filter(Boolean)
    .includes(wanted);
};

/**
 * One ballot per person per turn.
 *
 * Deliberately a keyed digest rather than a bare hash of the login_id: a plain
 * hash is trivially reversed by hashing the (public) list of employee names, so
 * anybody holding a database dump could map hashes back to voters. The key is
 * server-only, so the digest cannot be recomputed off-box.
 */
export const hashVoterKey = (turnId, loginId) =>
  crypto.createHmac('sha256', ballotSecret()).update(`${turnId}:${String(loginId).trim().toLowerCase()}`).digest('hex');

/**
 * Turn a group's membership rows + candidate workers into the final roster.
 *
 * Two independent inputs:
 *   - `memberRows`  rows of { worker_id, is_excluded }
 *   - `candidates`  the workers that matched the group's match_department, or
 *                   exactly the explicitly-included workers when the group is
 *                   locked (the caller picks which, based on the same test below)
 *
 * Rule: the roster is the candidate set minus everyone flagged is_excluded.
 * Callers pass candidates = the explicit include-set when one exists, otherwise
 * the department match, so a group can be "everyone in Digital" or "exactly these
 * three developers" with the same two tables.
 */
export const resolveRoster = (memberRows = [], candidates = []) => {
  const excluded = new Set(
    memberRows.filter((m) => m.is_excluded).map((m) => String(m.worker_id)),
  );
  return candidates.filter((w) => !excluded.has(String(w.id)));
};

/** True when the group defines its membership by hand rather than by department match. */
export const isExplicitRoster = (dept, memberRows = []) =>
  !!dept?.is_locked || memberRows.some((m) => !m.is_excluded);

// ── departments ────────────────────────────────────────────────────────────

export const listDepartments = async () => {
  const { data, error } = await db.from(DEPTS_TABLE).select('*').order('order_index', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const getDepartment = async (id) => {
  const { data, error } = await db.from(DEPTS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

export const updateDepartment = async (id, patch) => {
  const writable = {};
  if (patch.name != null) writable.name = String(patch.name).trim();
  if (patch.order_index != null) writable.order_index = Number(patch.order_index);
  if (patch.match_department !== undefined) {
    const v = patch.match_department == null ? '' : String(patch.match_department).trim();
    writable.match_department = v || null;
  }
  if (patch.is_locked !== undefined) writable.is_locked = !!patch.is_locked;

  if (Object.keys(writable).length === 0) return getDepartment(id);
  const { data, error } = await db
    .from(DEPTS_TABLE)
    .update({ ...writable, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const listDepartmentMembers = async (departmentId) => {
  const { data, error } = await db
    .from(MEMBERS_TABLE)
    .select('*')
    .eq('department_id', departmentId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const listAllDepartmentMembers = async () => {
  const { data, error } = await db.from(MEMBERS_TABLE).select('*');
  if (error) throw error;
  return data || [];
};

/**
 * Replace a group's membership rows wholesale.
 *
 * A whole-table replace rather than a diff: the control panel always sends the
 * complete picked list, and computing a diff would only add ways for the stored
 * set and the shown set to disagree.
 */
export const setDepartmentMembers = async (departmentId, { include = [], exclude = [] }) => {
  const seen = new Set();
  const rows = [];
  for (const id of include) {
    const k = String(id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    rows.push({ department_id: departmentId, worker_id: k, is_excluded: false });
  }
  for (const id of exclude) {
    const k = String(id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    rows.push({ department_id: departmentId, worker_id: k, is_excluded: true });
  }

  return db.transaction(async (tx) => {
    await tx.from(MEMBERS_TABLE).delete().eq('department_id', departmentId);
    if (rows.length) {
      const { error } = await tx.from(MEMBERS_TABLE).insert(rows);
      if (error) throw error;
    }
    return rows;
  });
};

// ── worker roster ──────────────────────────────────────────────────────────

// Mirrors the active-staff filter used by the rest of the app
// (chatModel.listCommunityCandidates, authController's staff roster) so a person
// who is not eligible to work today is also not eligible to be nominated.
const ACTIVE_WORKERS_WHERE = `
  COALESCE(is_active, TRUE) = TRUE
  AND COALESCE(employment_status, 'active') NOT IN ('terminated', 'absconded', 'offboarded')
  AND COALESCE(is_test, FALSE) = FALSE
`;

const WORKER_COLUMNS = 'id, name, login_id, employee_id, department, team, photo_url';

const fetchWorkersByIds = async (ids) => {
  if (!ids.length) return [];
  const { rows } = await db._pool.query(
    `SELECT ${WORKER_COLUMNS} FROM workers
     WHERE id = ANY($1::uuid[]) AND ${ACTIVE_WORKERS_WHERE}
     ORDER BY lower(name)`,
    [ids],
  );
  return rows;
};

const fetchWorkersByDepartment = async (department) => {
  // match_department may be a list ("HR, HR-Recruiter"); split it here so the
  // roster query and the voter-resolution share the same notion of a group.
  const matches = String(department || '')
    .split(/[,|\n]/)
    .map(normDept)
    .filter(Boolean);
  if (!matches.length) return [];
  const { rows } = await db._pool.query(
    `SELECT ${WORKER_COLUMNS} FROM workers
     WHERE lower(btrim(COALESCE(department, ''))) = ANY($1::text[]) AND ${ACTIVE_WORKERS_WHERE}
     ORDER BY lower(name)`,
    [matches],
  );
  return rows;
};

export const getWorkerByLoginId = async (loginId) => {
  const { rows } = await db._pool.query(
    `SELECT ${WORKER_COLUMNS} FROM workers WHERE lower(btrim(login_id)) = lower(btrim($1)) LIMIT 1`,
    [String(loginId || '')],
  );
  return rows[0] || null;
};

/** Searchable employee list for the control panel's member picker. */
export const searchWorkers = async (term, limit = 50) => {
  const t = String(term || '').trim();
  const { rows } = await db._pool.query(
    `SELECT ${WORKER_COLUMNS} FROM workers
     WHERE ${ACTIVE_WORKERS_WHERE}
       AND ($1 = '' OR lower(name) LIKE '%' || lower($1) || '%'
                       OR lower(COALESCE(login_id, '')) LIKE '%' || lower($1) || '%'
                       OR lower(COALESCE(employee_id, '')) LIKE '%' || lower($1) || '%'
                       OR lower(COALESCE(department, '')) LIKE '%' || lower($1) || '%')
     ORDER BY lower(name)
     LIMIT $2`,
    [t, Math.min(Number(limit) || 50, 200)],
  );
  return rows;
};

/**
 * How many people are allowed to vote at all.
 *
 * Every active employee votes in every department, so this is the denominator
 * for every department's "x of y voted" — not the size of that department's own
 * roster, which is now just the number of candidates on its ballot.
 */
export const countEligibleVoters = async () => {
  const { rows } = await db._pool.query(`SELECT count(*)::int AS n FROM workers WHERE ${ACTIVE_WORKERS_WHERE}`);
  return rows[0]?.n ?? 0;
};

/** Resolved roster for one group. */
export const getDepartmentRoster = async (dept) => {
  const memberRows = await listDepartmentMembers(dept.id);
  const candidates = isExplicitRoster(dept, memberRows)
    ? await fetchWorkersByIds(memberRows.filter((m) => !m.is_excluded).map((m) => m.worker_id))
    : await fetchWorkersByDepartment(dept.match_department);
  return resolveRoster(memberRows, candidates);
};

/** Resolved roster for every group, plus the group a given login belongs to. */
export const getAllRosters = async () => {
  const depts = await listDepartments();
  const memberRows = await listAllDepartmentMembers();
  const out = [];
  for (const d of depts) {
    const rows = memberRows.filter((m) => Number(m.department_id) === Number(d.id));
    const candidates = isExplicitRoster(d, rows)
      ? await fetchWorkersByIds(rows.filter((m) => !m.is_excluded).map((m) => m.worker_id))
      : await fetchWorkersByDepartment(d.match_department);
    out.push({ ...d, members: resolveRoster(rows, candidates) });
  }
  return out;
};

// ── sessions + turns ───────────────────────────────────────────────────────

export const createSession = async (body, actor) => {
  const title = String(body.title || '').trim();
  if (!title) throw new Error('Ceremony title is required');
  const turnMinutes = Math.min(Math.max(Number(body.turn_minutes) || 5, 1), 120);

  const depts = await listDepartments();
  if (!depts.length) throw new Error('No voting departments are configured');

  const session = await db.transaction(async (tx) => {
    const { data, error } = await tx
      .from(SESSIONS_TABLE)
      .insert({
        title,
        tagline: String(body.tagline || '').trim() || null,
        award_label: String(body.award_label || '').trim() || 'Star of the Department',
        status: 'draft',
        allow_self_vote: !!body.allow_self_vote,
        turn_minutes: turnMinutes,
        created_by: actor || null,
      })
      .select()
      .single();
    if (error) throw error;

    // One scheduled turn per group, in ceremony order. Nothing is open yet —
    // the start action opens the first one.
    const { error: turnError } = await tx.from(TURNS_TABLE).insert(
      depts.map((d) => ({
        session_id: data.id,
        department_id: d.id,
        order_index: d.order_index,
        status: 'pending',
      })),
    );
    if (turnError) throw turnError;
    return data;
  });

  return session;
};

export const listSessions = async (limit = 20) => {
  const { data, error } = await db
    .from(SESSIONS_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 20, 100));
  if (error) throw error;
  return data || [];
};

export const getSession = async (id) => {
  const { data, error } = await db.from(SESSIONS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

/** The most recent ceremony of any status, used for the after-the-fact results reveal. */
export const getRecentSession = async () => {
  const { data, error } = await db
    .from(SESSIONS_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
};

/** The ceremony a voter should be looking at: the live one, else the newest draft. */
export const getActiveSession = async () => {
  const { data, error } = await db
    .from(SESSIONS_TABLE)
    .select('*')
    .in('status', ['live', 'draft'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
};

/**
 * The unauthenticated answer to "is a ceremony running?".
 *
 * Deliberately thin: just enough for the login screen to say whether signing in
 * is worth offering, and nothing about departments, rosters, turns or counts.
 * Without this the booth cannot honour "only they will be able to log in" - the
 * voter endpoints all sit behind a token, so the login page would have no way to
 * know whether to accept a password.
 */
export const getPublicStatus = async () => {
  const { data, error } = await db
    .from(SESSIONS_TABLE)
    .select('id, title, status, started_at')
    .in('status', ['live', 'draft'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const s = (data || [])[0] || null;
  return {
    live: !!s && s.status === 'live',
    session_id: s?.id ?? null,
    title: s?.title ?? null,
    status: s?.status ?? 'none',
    started_at: s?.started_at ?? null,
  };
};

export const listTurns = async (sessionId) => {
  const { data, error } = await db
    .from(TURNS_TABLE)
    .select('*')
    .eq('session_id', sessionId)
    .order('order_index', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const getTurn = async (sessionId, departmentId) => {
  const { data, error } = await db
    .from(TURNS_TABLE)
    .select('*')
    .eq('session_id', sessionId)
    .eq('department_id', departmentId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

export const closeTurn = async ({ sessionId, departmentId, actor }) => {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from(TURNS_TABLE)
    .update({ status: 'closed', closed_by: actor || null, closed_at: now })
    .eq('session_id', sessionId)
    .eq('department_id', departmentId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

/**
 * Open every department's ballot at once, all sharing a single window.
 *
 * The ceremony is not a relay: every group is votable for the whole of the
 * ceremony, and every employee may vote in every group. Turns remain as rows
 * because they are the unit of anonymity (one ballot per turn per person) and
 * the unit the tally groups by — they just all share one open/close window.
 */
export const openAllTurns = async ({ sessionId, minutes, actor }) => {
  const now = new Date();
  const stamp = now.toISOString();
  const closes = new Date(now.getTime() + minutes * 60 * 1000).toISOString();

  const { data, error } = await db
    .from(TURNS_TABLE)
    .update({ status: 'open', opens_at: stamp, closes_at: closes, opened_by: actor || null, opened_at: stamp })
    .eq('session_id', sessionId)
    .neq('status', 'closed')
    .select();
  if (error) throw error;

  await db
    .from(SESSIONS_TABLE)
    .update({ status: 'live', started_at: stamp, current_department_id: null })
    .eq('id', sessionId);
  return data || [];
};

/** Shut every still-open ballot. Used by "Finish the ceremony". */
export const closeAllTurns = async ({ sessionId, actor }) => {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from(TURNS_TABLE)
    .update({ status: 'closed', closed_by: actor || null, closed_at: now })
    .eq('session_id', sessionId)
    .eq('status', 'open')
    .select();
  if (error) throw error;
  return data || [];
};

export const updateSession = async (id, patch) => {
  const writable = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) writable.status = patch.status;
  if (patch.current_department_id !== undefined) writable.current_department_id = patch.current_department_id;
  if (patch.started_at !== undefined) writable.started_at = patch.started_at;
  if (patch.completed_at !== undefined) writable.completed_at = patch.completed_at;
  const { data, error } = await db.from(SESSIONS_TABLE).update(writable).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

// ── ballots ────────────────────────────────────────────────────────────────

/**
 * The team keys this person has already recorded in one turn.
 *
 * Only keys come back — never a nominee, never a timestamp — so the answer
 * cannot be used to work out a past choice. A non-empty set means the ballot is
 * done: every pick is written in one statement, so a ballot is never half
 * recorded and "some rows exist" is the same test as "they voted".
 */
export const getVoterTeamKeys = async (turnId, voterHash) => {
  const { data, error } = await db
    .from(BALLOTS_TABLE)
    .select('team_key')
    .eq('turn_id', turnId)
    .eq('voter_hash', voterHash);
  if (error) throw error;
  return new Set((data || []).map((r) => String(r.team_key ?? '')));
};

/**
 * Which of these turns has this person voted in?
 *
 * Lets the booth show "Vote" vs "Voted ✓" per department so someone walking the
 * six ballots can see where they are. Only turn ids come back — never a nominee,
 * never a timestamp — so the response cannot be used to work out a past choice.
 *
 * Counts how many teams each turn has a row for, because a pick is now recorded
 * one team at a time: someone who has voted for two of four teams is still part
 * way through that ballot, not finished with it.
 */
export const getVotedTurnCounts = async (turnIds = [], loginId) => {
  if (!turnIds.length) return new Map();
  const byTurn = new Map(turnIds.map((id) => [id, hashVoterKey(id, loginId)]));
  const { data, error } = await db
    .from(BALLOTS_TABLE)
    .select('turn_id')
    .in('voter_hash', [...byTurn.values()]);
  if (error) throw error;
  const counts = new Map();
  for (const r of data || []) {
    const id = Number(r.turn_id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
};

/**
 * Record a whole ballot — one row per team — in a single statement.
 *
 * One statement rather than a loop so the pick per team is atomic: either the
 * department's ballot exists in full or it was never written, and there is no
 * half-recorded state for the "have I voted?" check to trip over.
 */
export const insertBallots = async (rows) => {
  const { data, error } = await db
    .from(BALLOTS_TABLE)
    .insert(rows)
    .select('id, team_key, created_at');
  if (error) throw error;
  return data || [];
};

/**
 * Per-group vote totals for the live board and the results reveal, split by team
 * as well as by department.
 *
 * Deliberately an aggregate: the caller receives counts, never a
 * nominee→voter mapping, and voter_hash is not selected at all.
 *
 * The rows are ordered department, then votes descending, then name — so the
 * board's flat "top five" and the Excel export stay department-wide as before,
 * and callers that need a team breakdown pick it out of these same rows rather
 * than the query being reshaped for them.
 */
export const tallyResults = async (sessionId) => {
  const { rows } = await db._pool.query(
    `SELECT t.department_id,
            t.id            AS turn_id,
            t.status        AS turn_status,
            t.order_index,
            COALESCE(b.team_key, '') AS team_key,
            b.nominee_id,
            w.name          AS nominee_name,
            w.employee_id   AS nominee_employee_id,
            w.team          AS nominee_team,
            w.photo_url     AS nominee_photo_url,
            COUNT(b.id)::int AS votes
       FROM voting_turns t
       LEFT JOIN voting_ballots b ON b.turn_id = t.id
       LEFT JOIN workers w       ON w.id = b.nominee_id
      WHERE t.session_id = $1
      GROUP BY t.department_id, t.id, t.status, t.order_index,
               COALESCE(b.team_key, ''), b.nominee_id,
               w.name, w.employee_id, w.team, w.photo_url
      ORDER BY t.order_index, votes DESC, lower(w.name)`,
    [sessionId],
  );
  return rows;
};

/** How many people have voted in this turn, counting each voter once. */
export const countBallotsForTurn = async (turnId) => {
  const { rows } = await db._pool.query(
    'SELECT COUNT(DISTINCT voter_hash)::int AS n FROM voting_ballots WHERE turn_id = $1',
    [turnId],
  );
  return rows[0]?.n || 0;
};

// ── audit ──────────────────────────────────────────────────────────────────

export const addAudit = async (sessionId, action, actor, detail = null) => {
  const { data, error } = await db
    .from(AUDIT_TABLE)
    .insert({ session_id: sessionId, action, actor: actor || null, detail })
    .select('id, action, actor, detail, created_at')
    .single();
  if (error) throw error;
  return data;
};

export const listAudit = async (sessionId) => {
  const { data, error } = await db
    .from(AUDIT_TABLE)
    .select('id, action, actor, detail, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};
