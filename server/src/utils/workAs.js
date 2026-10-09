// Work-as identity + arbitration. Both of these used to be inline in a request
// handler and a query loop, which is how a chained switch ended up recording the
// previous target as the operator and how an operator's displayed row kept
// changing between covers. Both are pure so they can be unit-tested directly.

// The real operator for a work-as switch.
//
// While impersonating, the JWT's `id` and `name` ARE the covered FRO — the
// operator is in `imposter_id` / `imposter_name`. Reading `id`/`name` on a
// chained switch therefore stamped the previous target onto the new target's row
// as its "operator", which made a covered FRO render as an acting operator in the
// NGO dashboard and handed them the covered row's live counters.
export function resolveOperatorIdentity(user) {
  const chained = !!(user?.impersonation && user?.imposter_id);
  return {
    chained,
    imposterId: chained ? user.imposter_id : user?.id,
    imposterName: chained ? (user.imposter_name || '') : (user?.name || ''),
  };
}

// Map operator id -> the one covered row that represents them.
//
// An operator routinely covers SEVERAL FROs at once, so "which row is this
// operator working" needs a total order. First-seen-wins was not one: the
// underlying queries have no ORDER BY, so PostgREST row order shifts whenever
// any covered row is written (~60s per live panel) and the operator's presence
// flipped between targets non-deterministically. Most-recently-written wins,
// with worker_id as a tie-break so identical timestamps are still stable.
export function buildWorkAsByOp(rows, isLiveFresh) {
  const byOperator = new Map();
  for (const s of rows || []) {
    if (!s?.work_as_operator_id || !isLiveFresh(s)) continue;
    const op = String(s.work_as_operator_id);
    const best = byOperator.get(op);
    if (!best) { byOperator.set(op, s); continue; }
    const bestAt = best.updated_at ? new Date(best.updated_at).getTime() : 0;
    const candAt = s.updated_at ? new Date(s.updated_at).getTime() : 0;
    if (candAt > bestAt || (candAt === bestAt && String(s.worker_id) < String(best.worker_id))) {
      byOperator.set(op, s);
    }
  }
  return byOperator;
}

// ---------------------------------------------------------------------------
// Cover relationships, read from work_as_sessions instead of the live row.
//
// The live row's work_as_operator_id is a single slot: one "who is operating
// me" per person, rewritten by every heartbeat. That cannot express a chain —
// Riya covered by Priya while Riya herself covers Meera — because one of the two
// facts overwrites the other and the relationship flickers between screens. It
// also cannot express two people sharing one laptop profile.
//
// work_as_sessions is one row per (operator, covered target), so it holds any
// number of relationships including a chain. These helpers are the pure core,
// unit-tested directly, so the model layer stays a thin query wrapper.
// ---------------------------------------------------------------------------

// target id -> [{ operatorUserId, operatorName }] for every active cover.
// Several operators may cover the same person, so the value is a list.
export function indexCovers(sessions) {
  const byTarget = new Map();
  for (const s of sessions || []) {
    const target = String(s?.target_fro_worker_id ?? '');
    const op = String(s?.operator_user_id ?? '');
    if (!target || !op) continue;
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push({ operatorUserId: op, operatorName: s.operator_name || '' });
  }
  return byTarget;
}

// The reverse index: operator id -> [targets they are covering].
export function groupCoversByOperator(sessions) {
  const byOperator = new Map();
  for (const s of sessions || []) {
    const op = String(s?.operator_user_id ?? '');
    const target = String(s?.target_fro_worker_id ?? '');
    if (!target || !op) continue;
    if (!byOperator.has(op)) byOperator.set(op, []);
    byOperator.get(op).push(target);
  }
  return byOperator;
}

// Is this person currently being covered by anyone?
//
// A covered FRO who is away must not accrue idle: the work on their station is
// being done by somebody else, so crediting them for sitting still bills them
// for time they were not present. Note this asks only "does a cover exist", not
// "is the cover active right now" — the caller owns liveness, because only it
// knows whether the operator is still refreshing.
export function isCovered(coversByTarget, targetWorkerId) {
  const list = coversByTarget?.get(String(targetWorkerId ?? ''));
  return Array.isArray(list) && list.length > 0;
}

// Pure form of the "covered and gone quiet" test, so the policy can be tested
// without a database. `isSelfFresh` says whether the covered FRO's own live row
// is still being refreshed.
//
// This is what keeps a covered-away FRO from being billed idle: their row going
// quiet means their panel is closed, not that they were sitting idle, and the
// stale disposition deadline on it would otherwise be backdated into hours of
// invented idle. A covered FRO who is still refreshing their own row is at the
// desk and accrues normally, so a cover taken out while the FRO keeps working
// costs them nothing.
export function isCoveredAndAway({ coversByTarget, targetWorkerId, isSelfFresh, nowMs = Date.now(), staleMs = 90 * 1000 }) {
  if (!isCovered(coversByTarget, targetWorkerId)) return false;
  if (typeof isSelfFresh === 'function') return !isSelfFresh(targetWorkerId, nowMs);
  return false;
}

// Which worker id should a live-status write be filed under?
//
// This is the core of the reporting fix. While work-as is active the JWT's `id`
// is the COVERED FRO, so keying the live row on it filed the operator's activity
// under the covered person. Two people active at once (Priya covering Riya while
// the real Riya works her own account) then wrote to the SAME row, last write
// wins: the work_as_operator_id marker got cleared by the covered FRO's own
// heartbeat, one person's idle timer cancelled the other's, and today_calls /
// today_talk_seconds merged via the max() keep-larger rule. It also left the
// operator's own row stale with a lapsed disposition_due_at, which
// stampLapsedIdle() later backdated — inventing hours of idle for someone who
// was demonstrably working.
//
// Filing on the real human fixes all of it at the source: each person owns one
// row, so nothing can overwrite anything, and the cover relationship is carried
// by work_as_sessions rather than by the row.
//
// `painted` is the identity the UI is showing (the covered FRO under work-as);
// `operator` is the human at the keyboard. Non-impersonating users have no
// operator, so the painted id is used and nothing changes for them.
//
// `isAgent` is the one deliberate exception, and it is not optional bookkeeping.
// A login agent is not a second person at the keyboard — they are the assigned
// FRO's hands, and the whole point of the feature is that the FRO shows up on the
// performance board as the one working. Filing on the agent instead would write
// the agent's uuid into fro_live_status.worker_id and fro_time_sessions.worker_id,
// and both of those carry FOREIGN KEYS to workers(id): the agent has no workers
// row, so the heartbeat would fail outright rather than merely be invisible. It
// would also leave the FRO offline and their figures at zero, which is the exact
// behaviour this branch exists to prevent.
export function liveRowWorkerId({ paintedId, operatorId, isAgent }) {
  const painted = String(paintedId ?? '');
  if (isAgent) return painted;
  const operator = operatorId == null || operatorId === '' ? '' : String(operatorId);
  return operator || painted;
}

// Is this request an agent session rather than a person manually acting as a FRO?
//
// The two are deliberately kept distinct all the way through the reporting path.
// A manual work-as switch has a real operator who owns a row of their own and is
// shown as covering somebody. An agent has no row of their own: their activity IS
// the assigned FRO's activity, and the cover relationship is only a label on the
// admin board. Confusing the two is what would put an agent uuid into a table
// foreign-keyed to workers.
export function isAgentSession(user) {
  return !!(user?.agent_user_id);
}

// Split a request's worker context into the two identities that were previously
// conflated. `data` follows the painted account (the queue, donors, stations
// being worked); `human` follows the person at the keyboard (live counters, card
// figures, presence). They are equal unless a work-as switch is active.
export function splitWorkerContext(user) {
  const isAgent = isAgentSession(user);
  const { imposterId, imposterName, chained } = resolveOperatorIdentity(user);
  const paintedId = user?.id;
  const humanId = liveRowWorkerId({ paintedId, operatorId: imposterId, isAgent });
  return {
    chained,
    isAgent,
    data: { id: paintedId, name: user?.name || '' },
    human: {
      id: humanId,
      name: String(humanId) === String(paintedId) ? (user?.name || '') : (imposterName || ''),
    },
    // An agent is not "acting as" the FRO on the reporting side: both contexts
    // resolve to the same person, which is what makes their session behave
    // exactly like the FRO's own.
    isWorkAs: chained && String(humanId) !== String(paintedId),
    // Present only on agent sessions, so the UI can say who is actually typing
    // without inventing a second identity for the live row to point at.
    agent: isAgent ? { id: String(user.agent_user_id), label: user.agent_label || '' } : null,
  };
}
