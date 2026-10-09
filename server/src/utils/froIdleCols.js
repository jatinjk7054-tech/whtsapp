// The live-row columns every read-only idle surface needs.
//
// WHY THIS EXISTS AS A SHARED LIST. Each read path used to hand-write its own
// column list, and the omissions were silent: a missing column does not raise an
// error, it simply arrives as undefined and quietly changes the answer. That is
// how the FRO's performance strip came to disagree with the FRO's own panel
// timer about the same person at the same moment.
//
// stats_date
//   liveIdleSeconds() decides whether a banked total belongs to today by reading
//   stats_date. Without it the day is inferred from updated_at instead, and a
//   valid banked total can be discarded as though it described a previous day —
//   which displays a figure of zero for idle the officer genuinely sat through.
//
// frozen_at
//   The stamp at which a meeting or admin pause began. An idle period that had
//   already started when the freeze hit stops accruing there, so the held stretch
//   counts as work rather than idle. The panel timer saw this column and the
//   strip did not.
//
// Anything that computes a displayed idle total must read from this list, so the
// figures cannot drift apart screen by screen.
//
// It lives in its own dependency-free module because both froController and
// ngoAdminController need it, and importing one controller from the other would
// create a cycle.
export const FRO_IDLE_LIVE_COLS = [
  'worker_id',
  'status',
  'stats_date',
  'today_talk_seconds',
  'today_calls',
  'updated_at',
  'disposition_due_at',
  'is_paused',
  'paused_at',
  'paused_by',
  'frozen_at',
  'work_as_operator_id',
  'work_as_operator_name',
].join(', ');

export default FRO_IDLE_LIVE_COLS;
