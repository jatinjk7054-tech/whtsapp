// The single re-arm point for the FRO's 4-minute disposition window.
//
// Under the server-authoritative time machine the window is reset ONLY by a
// successful, backend-confirmed disposition. Every other save (donation, call,
// visit, message, follow_up, note) is recorded work but does not discharge the
// disposition the worker still owes, so those callers do NOT invoke this — the
// gate lives at the call site in createDonorLogHandler. Mouse/keyboard/click/
// scroll/tab activity is never an input at all.
//
// Callers must pass the HUMAN worker id (the person at the keyboard) — the same
// identity the heartbeat, /status/me, and every board read uses, so a work-as
// disposition cannot leave the operator's own row stale. buildLiveWindow() is
// the pure arithmetic so the rule is unit-testable without a database.
//
// Idle seconds are NOT accumulated here. The authoritative idle total is the
// sum of the open/closed intervals in fro_time_sessions; the legacy
// today_idle_seconds column is derived from that ledger on read (see
// froTimeStatus.js) and is never written by this module.
import db from '../config/db.js';
import {
  DISPOSITION_WINDOW_SECONDS,
  getShiftWindowMs,
  istDateStr,
  nextDeadline,
} from '../utils/froIdle.js';
import { rollCountersForNewDay, COUNTER_COLUMNS } from './froCounterDay.js';

// Pure: derive the upsert patch and the client-facing timer from a row + shift.
//
// Re-arms the deadline, clears idle_since, and punches an idle row back online
// unless the admin has frozen it (pause/meeting). It never folds elapsed time
// into today_idle_seconds — the ledger owns that number.
export function buildLiveWindow({ workerId, liveRow, shift, nowMs = Date.now() }) {
  const due = nextDeadline(shift, nowMs);
  const frozen = !!(liveRow?.is_paused) || liveRow?.status === 'meeting';
  const patch = {
    worker_id: workerId,
    disposition_due_at: due,
    idle_since: null,
    updated_at: new Date(nowMs).toISOString(),
    stats_date: istDateStr(new Date(nowMs)),
  };

  // Punch an idle row back online, but never through a freeze the admin set.
  if (liveRow?.status === 'idle' && !frozen) {
    patch.status = 'online';
    patch.current_donor_id = null;
    patch.call_started_at = null;
  }

  const timer = {
    disposition_due_at: due,
    seconds_left: due ? DISPOSITION_WINDOW_SECONDS : null,
    is_idle: false,
  };

  return { patch, timer };
}

// Re-arm the human-at-the-keyboard's live window after a successful save.
//
// `workerId` must already be the HUMAN id (operator under work-as, plain id
// otherwise). Shift and db are injectable so the orchestration can be tested
// without a database; the live-status read/upsert and the daily snapshots all
// go through dbClient. Returns the timer shape the client adopts, or null.
export async function resetLiveWindow(workerId, {
  nowMs = Date.now(),
  dbClient = db,
  getShift = getShiftWindowMs,
  dbg = 'action',
} = {}) {
  const shift = await getShift(workerId, nowMs);
  const { data: liveRow } = await dbClient
    .from('fro_live_status')
    .select('*')
    .eq('worker_id', workerId)
    .maybeSingle();

  // Bank a stale row's day and start today at zero BEFORE the window is rebuilt.
  //
  // buildLiveWindow always stamps stats_date to today. If this row still described
  // yesterday - nobody stamped the FRO, no heartbeat landed, the machine was off -
  // that stamp used to relabel yesterday's accumulated counters as today's
  // WITHOUT banking them to fro_daily_stats. Two consequences: the day's real total
  // was lost, and because the counters can only ever rise (GREATEST on both the
  // snapshot and the row), today started above zero and could not be walked back.
  // The rollover is what makes an impossible day like 52h unrepresentable, so it
  // has to run before the patch is built, not after.
  const roll = await rollCountersForNewDay(workerId, liveRow, nowMs, { dbg: 'live-window-roll' });

  const baseRow = roll.rolled
    ? { ...liveRow, ...roll.counters, disposition_due_at: null, stats_date: roll.statsDate }
    : liveRow;

  const { patch, timer } = buildLiveWindow({ workerId, liveRow: baseRow, shift, nowMs });

  // baseRow already reads as zeroed, but the patch is a partial upsert: columns it
  // omits keep their old stored values. Name every counter explicitly so a
  // relabelled row cannot carry a previous day forward.
  if (roll.rolled) {
    for (const col of COUNTER_COLUMNS) patch[col] = 0;
  }

  await dbClient.from('fro_live_status').upsert(patch, { onConflict: 'worker_id' });

  return timer;
}