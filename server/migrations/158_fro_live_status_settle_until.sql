-- 158: add settle_until to fro_live_status so login buys a fixed settle-in grace
--
-- WHY. The disposition window was opened by the FRO's first recorded action, so
-- the clock stayed frozen until then. Anyone could log in, sit on the panel for
-- an hour and record nothing, and that whole hour was free: with no
-- disposition_due_at on the row there is no deadline, no lapsed deadline, and
-- therefore no idle period for any reader to derive. The FRO only started being
-- billed once they had already done the work.
--
-- THE FIX. A one-time settle-in grace, then the normal window. The heartbeat
-- grants settle_until on the first panel presence of the IST day, and the first
-- heartbeat at or after it expires arms the ordinary 4-minute disposition
-- window. Seven minutes from login before any idle can accrue, three of which
-- are grace the FRO cannot be billed for.
--
-- WHY A SEPARATE COLUMN. idlePeriodStartMs and isIdleNow treat ANY lapsed
-- disposition_due_at as an open idle period. Storing the grace in that column
-- would make the server read the moment the grace expired as a missed
-- disposition - billing the FRO at the exact instant the grace is supposed to
-- hand over to the window. Keeping the grace in its own column puts it entirely
-- outside the idle arithmetic, so it cannot be mistaken for a lapse however it
-- is read.
--
-- Once per day, not once per session: a session-scoped grace could be farmed by
-- closing and reopening the panel, which would relocate the original exploit
-- rather than close it. Staleness is judged by IST day at read time, the same
-- rule withoutStaleIdle applies to idle_since, so no rollover bookkeeping is
-- needed to clear it.
--
-- DISPOSITION_WINDOW_SECONDS is untouched. This is a grace BEFORE the window,
-- not a shorter window.

ALTER TABLE fro_live_status
  ADD COLUMN IF NOT EXISTS settle_until timestamptz;

COMMENT ON COLUMN fro_live_status.settle_until IS
  'One-time settle-in grace granted on first panel presence of the IST day. Purely informational: it never participates in idle arithmetic. The first heartbeat at or after it arms the normal 4-minute disposition window.';
