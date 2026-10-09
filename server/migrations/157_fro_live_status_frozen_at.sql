-- 157: add frozen_at to fro_live_status so meeting/pause time is held, not idle
--
-- WHY. The disposition deadline (disposition_due_at) only ever froze on the
-- client. During a meeting or admin pause the panel's countdown stops, but the
-- server deadline kept ticking and lapsed mid-window. The moment the freeze
-- lifted, the heartbeat's own response read back "online + expired deadline",
-- flagged the FRO idle, and backdated idle_since to the expired moment inside
-- the frozen window — so the whole meeting/pause stretch was billed as idle,
-- on top of the clock-based Worked figure that already included it.
--
-- THE FIX. Track the moment a FRO enters a frozen state (meeting or pause):
--
--   - while frozen, all read paths cap open idle at frozen_at, so idle stops
--     accruing the instant the freeze starts; and
--   - when the freeze lifts, the heartbeat re-arms a fresh disposition window
--     instead of reading the lapsed deadline as idle.
--
-- The value is refreshed by updateLiveStatus / resumeOwnPause / setFroPaused
-- whenever a freeze begins. It is deliberately kept after the freeze lifts: it
-- keeps capping an idle period that had already begun when the freeze started,
-- and becomes inert the moment that period is resolved (the cap only bites open
-- idle that began at or before frozen_at).

ALTER TABLE fro_live_status
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz;

COMMENT ON COLUMN fro_live_status.frozen_at IS
  'Moment the FRO entered a held state (meeting or admin pause). Idle periods that began here or earlier stay capped while/when frozen; inert once that period is resolved.';