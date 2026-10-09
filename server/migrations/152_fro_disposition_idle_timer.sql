-- 152: FRO disposition-deadline idle timer (replaces break + skip tracking)
--
-- New rule: from the moment an FRO logs in, a 4-minute disposition timer runs
-- on every page. Recording a disposition resets it to 4:00. If it expires the
-- FRO is marked 'idle' and idle time starts accruing; the clock only stops when
-- the FRO clicks Resume, and the elapsed seconds are folded into that day's
-- total. Idle only accrues inside the shift window (attendance punch-in/out,
-- falling back to the configured shift times).
--
-- disposition_due_at is the server-authoritative deadline. The client only
-- mirrors it for the on-screen countdown, so a late/lying client can't dodge
-- the deadline: the heartbeat forces 'idle' once now() passes the deadline.
--
-- Break and skip tracking are removed. The FRO break button, break status,
-- break timer and the skip-lead action are gone, so their columns go with them.
-- pause/resume is untouched — that is the admin-controlled freeze and is a
-- separate feature.

-- ── The deadline column ──────────────────────────────────────────────────────
ALTER TABLE fro_live_status
  ADD COLUMN IF NOT EXISTS disposition_due_at TIMESTAMPTZ NULL;

-- Backfill anyone currently online with a full window from now, so the first
-- deploy doesn't instantly idle the whole team.
UPDATE fro_live_status
   SET disposition_due_at = now() + INTERVAL '4 minutes'
 WHERE disposition_due_at IS NULL
   AND status IN ('online', 'on_call');

-- ── Drop break tracking ──────────────────────────────────────────────────────
ALTER TABLE fro_live_status
  DROP COLUMN IF EXISTS today_break_seconds,
  DROP COLUMN IF EXISTS on_break,
  DROP COLUMN IF EXISTS break_started_at,
  DROP COLUMN IF EXISTS break_type,
  DROP COLUMN IF EXISTS is_auto_break;

-- ── Drop skip tracking ───────────────────────────────────────────────────────
ALTER TABLE fro_live_status
  DROP COLUMN IF EXISTS today_skipped;

ALTER TABLE fro_daily_stats
  DROP COLUMN IF EXISTS break_seconds,
  DROP COLUMN IF EXISTS skipped;

COMMENT ON COLUMN fro_live_status.disposition_due_at IS
  'Server-authoritative 4-minute disposition deadline. Reset on login and on every recorded disposition. Once now() passes it the FRO is forced to idle until they hit Resume.';
COMMENT ON COLUMN fro_live_status.idle_since IS
  'Start of the current uncommitted idle period. Cleared on Resume; folded into today_idle_seconds first.';
COMMENT ON COLUMN fro_live_status.today_idle_seconds IS
  'Committed idle seconds for the current IST day, clamped to the shift window.';
COMMENT ON COLUMN fro_daily_stats.idle_seconds IS
  'Greatest observed today_idle_seconds that day, so month/year totals can SUM() across dates.';
