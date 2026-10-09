import {
  listDepartments,
  getDepartment,
  updateDepartment,
  listDepartmentMembers,
  setDepartmentMembers,
  searchWorkers,
  getDepartmentRoster,
  getAllRosters,
  countEligibleVoters,
  getWorkerByLoginId,
  createSession,
  listSessions,
  getSession,
  getActiveSession,
  getRecentSession,
  getPublicStatus,
  listTurns,
  getTurn,
  openAllTurns,
  closeAllTurns,
  closeTurn as closeTurnModel,
  updateSession,
  getVoterTeamKeys,
  getVotedTurnCounts,
  insertBallots,
  tallyResults,
  countBallotsForTurn,
  addAudit,
  listAudit,
  hashVoterKey,
  groupByTeam,
  normTeam,
} from '../models/votingModel.js';
import { emitRealtime } from '../socket.js';

const VOTING_ROOM = 'voting';

// Every response carries server_now so the app can show a countdown that does
// not depend on the device clock being right.
const withServerNow = (payload) => ({ ...payload, server_now: new Date().toISOString() });

const actorOf = (req) => req.user?.login_id || req.user?.email || req.user?.name || null;

/**
 * A turn is only genuinely open while its window is still in the future.
 *
 * The stored `status` can be 'open' after the window lapses (HR has not clicked
 * close yet). Treating the stored value as truth would let anyone keep voting
 * past the deadline, so every read and write goes through this instead.
 */
const isTurnLive = (turn, now = new Date()) => {
  if (!turn || turn.status !== 'open') return false;
  if (!turn.closes_at) return false;
  return new Date(turn.closes_at).getTime() > now.getTime();
};

const shapeDepartment = (d) => ({
  id: d.id,
  name: d.name,
  order_index: d.order_index,
  match_department: d.match_department,
  is_locked: !!d.is_locked,
  member_count: Array.isArray(d.members) ? d.members.length : undefined,
});

/** The tally rows' team key, normalised — legacy rows have no team of their own. */
const rowTeamKey = (r) => String(r.team_key ?? '');

const shapeWinner = (row) => ({
  nominee_id: row.nominee_id,
  name: row.nominee_name,
  employee_id: row.nominee_employee_id,
  photo_url: row.nominee_photo_url,
  votes: row.votes,
});

/**
 * One group's outcome from its tally rows: total votes, the top row, and whether
 * the top is shared.
 *
 * A tie is reported rather than broken. Deciding between tied people is HR's
 * call, so the same shape feeds the board, the reveal and the export and none of
 * them can quietly pick a different winner from the others.
 */
const tallyOutcome = (rows) => {
  const votes = rows.reduce((s, r) => s + (r.votes || 0), 0);
  const top = rows.reduce((best, r) => (!best || (r.votes || 0) > best.votes ? r : best), null);
  const tied = top ? rows.filter((r) => r.votes === top.votes).length : 0;
  return {
    votes_cast: votes,
    winner: top && votes > 0 ? shapeWinner(top) : null,
    is_tie: !!(top && votes > 0 && tied > 1),
    tied_count: tied,
  };
};

/**
 * The winners of one department, one per team plus the department-wide top.
 *
 * The team winners are the point of team voting: a department of five teams has
 * five winners. The department-wide winner is kept alongside them because the
 * board and the Excel export have always shown one overall line per department,
 * and dropping it would change what HR exports as well as what they see.
 *
 * Teams are ordered by name, matching the ballot the voter filled in, so the
 * reveal reads in the same order they voted.
 *
 * `fallbackLabel` names the one group that never had a team of its own. It is
 * the department name, so a department where nobody has a team assigned reads as
 * a single pick for that department rather than a phantom "No team" winner.
 */
const buildTeamWinners = (rows, fallbackLabel = '') => {
  const byKey = new Map();
  for (const r of rows) {
    const key = rowTeamKey(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return [...byKey.entries()]
    .map(([key, teamRows]) => ({
      key,
      // The team as it reads now, falling back to the stored key if HR has since
      // renamed or blanked it, and to the caller's label when there is no team.
      label: String(teamRows[0]?.nominee_team ?? '').trim() || key || fallbackLabel,
      ...tallyOutcome(teamRows),
    }))
    .sort((a, b) => {
      if (a.key === b.key) return 0;
      if (!a.key) return 1;
      if (!b.key) return -1;
      return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
    });
};

/**
 * The final winners for the end-of-ceremony reveal. Shared with the HR board so
 * the two can never disagree, and only surfaced once every turn is done — the
 * votes stay private until then.
 */
const buildWinners = (departments, tally) =>
  departments.map((d) => {
    const rows = (tally || []).filter((r) => Number(r.department_id) === Number(d.id) && r.nominee_id);
    return {
      department: { id: d.id, name: d.name, order_index: d.order_index },
      ...tallyOutcome(rows),
      teams: buildTeamWinners(rows, d.name),
    };
  });

const broadcast = (sessionId, type, extra = {}) => {
  emitRealtime('voting:update', { type, session_id: sessionId, ...extra }, VOTING_ROOM);
};

/** Resolve the caller's worker row, or a clear 401 if the token is not a worker. */
const requireWorker = async (req, res) => {
  const loginId = req.user?.login_id;
  if (!loginId) {
    res.status(401).json({ message: 'Please log in with your employee account to vote' });
    return null;
  }
  const worker = await getWorkerByLoginId(loginId);
  if (!worker) {
    res.status(403).json({ message: 'Your employee record could not be found' });
    return null;
  }
  return worker;
};

/**
 * Public: is a ceremony running right now?
 *
 * The only unauthenticated endpoint in this module, and the only one a
 * non-signed-in browser can reach. It exists so the login screen can tell people
 * to come back later instead of taking a password for a ceremony that is not
 * open, and it returns nothing but a title and a status.
 */
export const getStatus = async (req, res) => {
  try {
    return res.json(withServerNow(await getPublicStatus()));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ── voter-facing ───────────────────────────────────────────────────────────

/**
 * Everything a voter needs to know where they stand, in one call.
 *
 * There is no "your turn" any more. Every department's ballot is open for the
 * whole ceremony and every employee may vote in every department, so this
 * returns the list of ballots with one flag each — have I voted here yet — and
 * nothing else. Deliberately no vote counts and no nominee detail: that would
 * either leak the running result or be wasted work on the grid.
 */
export const getCeremony = async (req, res) => {
  try {
    const worker = await requireWorker(req, res);
    if (!worker) return;

    const session = await getActiveSession();

    // No live or draft ceremony? If the last one is finished, the only honest
    // screen is the results — the winner is decided after everyone has voted
    // and the time has ended, so that is exactly when this state appears.
    if (!session) {
      const recent = await getRecentSession();
      if (recent && recent.status === 'completed') {
        const [tally, depts] = await Promise.all([tallyResults(recent.id), listDepartments()]);
        return res.json(
          withServerNow({
            session: {
              id: recent.id,
              title: recent.title,
              tagline: recent.tagline,
              award_label: recent.award_label,
              status: recent.status,
              turn_minutes: recent.turn_minutes,
              started_at: recent.started_at,
              completed_at: recent.completed_at,
            },
            state: 'results',
            results: buildWinners(depts, tally),
            department: null,
            turn: null,
          }),
        );
      }
      return res.json(withServerNow({ session: null, state: 'no_ceremony', department: null, turn: null }));
    }

    const [depts, turns] = await Promise.all([listDepartments(), listTurns(session.id)]);
    const votedTurnCounts = await getVotedTurnCounts(
      turns.map((t) => t.id),
      req.user.login_id,
    );
    const now = new Date();
    const live = session.status === 'live';

    // Every open ballot shares one window, so any of their closes_at is the
    // ceremony's deadline. Fall back to the earliest so an odd row cannot make
    // the countdown jump around.
    const closesAt =
      turns
        .filter((t) => isTurnLive(t, now))
        .map((t) => t.closes_at)
        .sort()[0] || null;

    // Each pick is recorded on its own, so a department is finished only once the
    // voter has a row for every team on it. Team counts come from the roster, the
    // same grouping the ballot itself uses.
    const rosters = await getAllRosters();
    const teamCounts = new Map(rosters.map((r) => [r.id, groupByTeam(r.members).length]));

    const departments = depts.map((d) => {
      const t = turns.find((x) => Number(x.department_id) === Number(d.id)) || null;
      const open = live && isTurnLive(t, now);
      const picked = t ? votedTurnCounts.get(Number(t.id)) || 0 : 0;
      const needed = teamCounts.get(d.id) || 0;
      return {
        id: d.id,
        name: d.name,
        order_index: d.order_index,
        open,
        voted: picked > 0 && picked >= needed,
        // Part way through: still open to vote in, so the grid must not mark it
        // done or the voter would be shut out of the teams they have not done.
        partial: picked > 0 && picked < needed,
        closes_at: t?.closes_at || null,
      };
    });

    return res.json(
      withServerNow({
        session: {
          id: session.id,
          title: session.title,
          tagline: session.tagline,
          award_label: session.award_label,
          status: session.status,
          turn_minutes: session.turn_minutes,
          started_at: session.started_at,
          closes_at: closesAt,
        },
        state: live ? 'voting' : 'not_started',
        closes_at: closesAt,
        department: null,
        turn: null,
        already_voted: departments.length > 0 && departments.every((d) => d.voted),
        departments,
      }),
    );
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Resolve the department whose ballot is being voted on, and the ballot itself.
 *
 * Any department in the ceremony is fair game for any signed-in employee, so
 * this is a lookup rather than a membership test. The only gate is that the
 * ballot is genuinely open right now.
 *
 * The nominees are returned twice over: flat, and grouped by team. The flat list
 * is what validation runs against; the groups are what the ballot is drawn as,
 * since the voter picks one person per team.
 */
const resolveOpenBallot = async (session, departmentId, worker) => {
  const dept = await getDepartment(departmentId);
  if (!dept) return { error: { status: 404, message: 'That department is not in this ceremony' } };

  const turn = await getTurn(session.id, dept.id);
  if (!isTurnLive(turn)) {
    return { error: { status: 409, message: 'Voting is not open right now' } };
  }

  const members = await getDepartmentRoster(dept);
  const nominees = members
    .filter((m) => session.allow_self_vote || String(m.id) !== String(worker.id))
    .map((m) => ({ id: m.id, name: m.name, employee_id: m.employee_id, department: m.department, team: m.team, photo_url: m.photo_url }));

  // The department name carries the label for the single-group fallback, so a
  // department with no teams reads as one pick for that department rather than
  // inventing a "No team" section the voter was never offered.
  return { dept, turn, members, nominees, teams: groupByTeam(nominees, { fallbackLabel: dept.name }) };
};

/** The team groups for one department's ballot. */
const shapeTeams = (teams) =>
  teams.map((t) => ({
    key: t.key,
    label: t.label,
    nominees: t.members,
  }));

/** The nominee list for one department's ballot, only while that ballot is open. */
export const getMyBallot = async (req, res) => {
  try {
    const worker = await requireWorker(req, res);
    if (!worker) return;

    const session = await getActiveSession();
    if (!session) return res.status(404).json({ message: 'There is no ceremony running right now' });

    const departmentId = String(req.query?.department_id || '').trim();
    if (!departmentId) return res.status(400).json({ message: 'Which department?' });

    const { error, dept, turn, teams } = await resolveOpenBallot(session, departmentId, worker);
    if (error) return res.status(error.status).json({ message: error.message });

    return res.json(
      withServerNow({
        session: { id: session.id, title: session.title, award_label: session.award_label },
        department: shapeDepartment(dept),
        turn: { id: turn.id, closes_at: turn.closes_at },
        // Grouped is what the voter is choosing within; flat is kept so the
        // payload still describes every nominee in one list.
        teams: shapeTeams(teams),
        nominees: teams.flatMap((t) => t.members),
        // Which teams this person has already voted in, so reopening a ballot
        // resumes where they left off instead of showing a team they cannot vote
        // in again. Team keys only — never a nominee — so this cannot reveal a
        // past choice.
        voted_team_keys: [...(await getVoterTeamKeys(turn.id, hashVoterKey(turn.id, req.user.login_id)))]
      }),
    );
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Cast one department's ballot: one pick per team, recorded together.
 *
 * The picks arrive as bare nominee ids and the team each one belongs to is
 * re-derived here from the roster, never taken from the client. So a caller
 * cannot vote for somebody twice by claiming two teams for them, and cannot slip
 * in a nominee from a team that is not on this ballot.
 *
 * The response is a bare confirmation — it deliberately does not echo the picks
 * back, so a shared screen cannot reveal what anyone picked.
 */
export const castVote = async (req, res) => {
  try {
    const worker = await requireWorker(req, res);
    if (!worker) return;

    const departmentId = String(req.body?.department_id || '').trim();
    if (!departmentId) return res.status(400).json({ message: 'Which department?' });

    // One id per team. A bare `nominee_id` is still honoured so a booth tab left
    // open from before this change can finish its vote.
    const legacy = String(req.body?.nominee_id || '').trim();
    const requested = Array.isArray(req.body?.picks)
      ? req.body.picks.map((p) => String(p?.nominee_id ?? p ?? '').trim()).filter(Boolean)
      : legacy
        ? [legacy]
        : [];
    if (!requested.length) return res.status(400).json({ message: 'Please choose one person for this team' });

    const session = await getActiveSession();
    if (!session) return res.status(404).json({ message: 'There is no ceremony running right now' });

    const { error, dept, turn, nominees, teams } = await resolveOpenBallot(session, departmentId, worker);
    if (error) return res.status(error.status).json({ message: error.message });

    const byId = new Map(nominees.map((n) => [String(n.id), n]));
    const seen = new Set();
    for (const id of requested) {
      if (!byId.has(id)) {
        return res.status(400).json({ message: 'That person is not on this department’s ballot' });
      }
      if (seen.has(id)) {
        return res.status(400).json({ message: 'The same person cannot be picked twice' });
      }
      seen.add(id);
    }

    // Each pick is sent on its own and becomes that team's vote immediately, so
    // the client no longer sends a full set of teams. A stale tab from the
    // all-at-once version can still send several at once, so a request covering
    // more than one team is refused rather than half-honoured.
    if (requested.length > 1) {
      return res.status(400).json({ message: 'Please vote one team at a time' });
    }

    const teamKey = normTeam(byId.get(seen.values().next().value).team);

    const voterHash = hashVoterKey(turn.id, req.user.login_id);
    const done = await getVoterTeamKeys(turn.id, voterHash);
    // The unique key is (turn, voter, team), so a team is recorded once. A repeat
    // here means a double tap or a second tab, and must not count twice.
    if (done.has(teamKey)) {
      return res.status(409).json({ message: 'You have already voted for this team' });
    }

    // One row for this team, keyed by the team the nominee is on.
    const rows = [
      {
        session_id: session.id,
        turn_id: turn.id,
        department_id: dept.id,
        nominee_id: seen.values().next().value,
        team_key: teamKey,
        voter_hash: voterHash,
      },
    ];

    try {
      await insertBallots(rows);
    } catch (e) {
      // 23505 = unique_violation. Two taps, or two tabs, raced each other past
      // the check above. The constraint is the real guarantee, so report it as
      // "already voted" rather than a server error.
      if (e?.code === '23505') return res.status(409).json({ message: 'You have already voted for this team' });
      throw e;
    }

    await addAudit(session.id, 'vote_cast', null, { department_id: dept.id, team: teamKey });
    broadcast(session.id, 'vote_cast', { department_id: dept.id });

    return res.status(201).json({ message: 'Your vote has been recorded', server_now: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ── HR / admin ─────────────────────────────────────────────────────────────

export const listAllDepartments = async (req, res) => {
  try {
    const rosters = await getAllRosters();
    return res.json(withServerNow({ departments: rosters.map(shapeDepartment) }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/** A group's stored membership rows plus its resolved roster. */
export const inspectDepartment = async (req, res) => {
  try {
    const dept = await getDepartment(req.params.id);
    if (!dept) return res.status(404).json({ message: 'Department not found' });
    const members = await listDepartmentMembers(dept.id);
    const roster = await getDepartmentRoster(dept);
    return res.json(withServerNow({ department: shapeDepartment(dept), overrides: members, roster }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editDepartment = async (req, res) => {
  try {
    const dept = await getDepartment(req.params.id);
    if (!dept) return res.status(404).json({ message: 'Department not found' });
    const updated = await updateDepartment(dept.id, req.body || {});
    broadcast(null, 'departments_changed');
    return res.json({ message: 'Department saved', department: shapeDepartment(updated) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const saveDepartmentMembers = async (req, res) => {
  try {
    const dept = await getDepartment(req.params.id);
    if (!dept) return res.status(404).json({ message: 'Department not found' });
    const include = Array.isArray(req.body?.include) ? req.body.include : [];
    const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude : [];
    await setDepartmentMembers(dept.id, { include, exclude });
    const roster = await getDepartmentRoster(dept);
    broadcast(null, 'departments_changed');
    return res.json({ message: 'Members saved', department: shapeDepartment(dept), roster });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const lookupWorkers = async (req, res) => {
  try {
    const workers = await searchWorkers(req.query.q, req.query.limit);
    return res.json(withServerNow({ workers }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAllSessions = async (req, res) => {
  try {
    return res.json(withServerNow({ sessions: await listSessions() }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const startSession = async (req, res) => {
  try {
    const session = await createSession(req.body || {}, actorOf(req));
    await addAudit(session.id, 'ceremony_created', actorOf(req), { title: session.title });
    broadcast(session.id, 'ceremony_created');
    return res.status(201).json({ message: 'Ceremony created', session });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

/**
 * Start the ceremony: open every department's ballot at once.
 *
 * There is no running order any more. All six ballots share one window, every
 * employee may vote in all six, and nobody waits for anybody — so "start" is a
 * single action rather than six.
 */
export const openTurn = async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ message: 'Ceremony not found' });
    if (session.status === 'completed') return res.status(409).json({ message: 'This ceremony has already finished' });

    const minutes = Math.min(Math.max(Number(req.body?.minutes) || session.turn_minutes || 5, 1), 120);
    const turns = await openAllTurns({ sessionId: session.id, minutes, actor: actorOf(req) });

    await addAudit(session.id, 'ceremony_started', actorOf(req), { minutes, departments: turns.length });
    broadcast(session.id, 'ceremony_started', { minutes });

    return res.json({ message: 'Voting is now open in every department', turns, minutes });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Close one department's ballot early — for example a group with nobody on it.
 * The rest of the ceremony carries on; use Finish to end the whole thing.
 */
export const closeTurn = async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ message: 'Ceremony not found' });

    const turn = await getTurn(session.id, req.params.deptId);
    if (!turn) return res.status(404).json({ message: 'That department is not in this ceremony' });
    if (turn.status === 'closed') return res.status(409).json({ message: 'That department is already closed' });

    await closeTurnModel({ sessionId: session.id, departmentId: turn.department_id, actor: actorOf(req) });

    await addAudit(session.id, 'turn_closed', actorOf(req), { department_id: turn.department_id });
    broadcast(session.id, 'turn_closed', { department_id: turn.department_id });

    return res.json({ message: 'Voting closed' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * Finish the ceremony.
 *
 * Shuts every still-open ballot and marks the session complete, which is what
 * flips the booth to the results reveal. This used to refuse while any turn was
 * open, which made the button impossible to use — closing the ballots is the
 * obvious part of finishing, not a prerequisite for it.
 */
export const completeSession = async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ message: 'Ceremony not found' });
    if (session.status === 'completed') return res.status(409).json({ message: 'This ceremony has already finished' });

    const closed = await closeAllTurns({ sessionId: session.id, actor: actorOf(req) });

    await updateSession(session.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      current_department_id: null,
    });
    await addAudit(session.id, 'ceremony_completed', actorOf(req), { closed_turns: closed.length });
    broadcast(session.id, 'ceremony_completed');

    return res.json({ message: 'Ceremony complete — results are now showing on the booths', closed_turns: closed.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/**
 * The live board: every group's order, roster size, turn state, how many have
 * voted, and the tally. Counts only — the tally query has no voter column.
 */
export const getBoard = async (req, res) => {
  try {
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ message: 'Ceremony not found' });

    const rosters = await getAllRosters();
    const turns = await listTurns(session.id);
    const [tally, eligibleVoters] = await Promise.all([tallyResults(session.id), countEligibleVoters()]);
    const now = new Date();

    const departments = rosters.map((d) => {
      const turn = turns.find((t) => Number(t.department_id) === Number(d.id)) || null;
      const rows = tally.filter((r) => Number(r.department_id) === Number(d.id) && r.nominee_id);
      const outcome = tallyOutcome(rows);
      // Roster teams are listed even with no votes yet, so HR can see that a
      // team exists but nobody picked anybody there before the ceremony closes.
      const teams = groupByTeam(d.members, { fallbackLabel: d.name }).map((t) => {
        const teamRows = rows.filter((r) => rowTeamKey(r) === t.key);
        return {
          key: t.key,
          label: t.label,
          candidates: t.members.length,
          ...tallyOutcome(teamRows),
        };
      });

      return {
        ...shapeDepartment(d),
        turn_status: turn ? (isTurnLive(turn, now) ? 'open' : turn.status === 'open' ? 'expired' : turn.status) : 'pending',
        opens_at: turn?.opens_at || null,
        closes_at: turn?.closes_at || null,
        votes_cast: outcome.votes_cast,
        ballots: outcome.votes_cast,
        // Every employee may vote in every department, so the denominator for
        // "x of y voted" is the whole company. `candidates` is how many names
        // are on this department's ballot.
        eligible: eligibleVoters,
        candidates: d.members.length,
        teams,
        results: rows.map((r) => ({
          nominee_id: r.nominee_id,
          name: r.nominee_name,
          employee_id: r.nominee_employee_id,
          photo_url: r.nominee_photo_url,
          team: r.nominee_team || null,
          votes: r.votes || 0,
        })),
        winner: outcome.winner
          ? { nominee_id: outcome.winner.nominee_id, name: outcome.winner.name, votes: outcome.winner.votes }
          : null,
        is_tie: outcome.is_tie,
        tied_count: outcome.tied_count,
      };
    });

    return res.json(
      withServerNow({
        session: {
          id: session.id,
          title: session.title,
          tagline: session.tagline,
          award_label: session.award_label,
          status: session.status,
          turn_minutes: session.turn_minutes,
          started_at: session.started_at,
          completed_at: session.completed_at,
        },
        departments,
      }),
    );
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getSessionAudit = async (req, res) => {
  try {
    return res.json(withServerNow({ audit: await listAudit(req.params.id) }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/** People who have voted in this turn, counting each voter once. */
export const getTurnProgress = async (req, res) => {
  try {
    const turn = await getTurn(req.params.id, req.params.deptId);
    if (!turn) return res.status(404).json({ message: 'That department is not in this ceremony' });
    return res.json(withServerNow({ votes: await countBallotsForTurn(turn.id) }));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
