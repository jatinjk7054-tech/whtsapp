-- 155: mark which IST day a live-status row's counters belong to
--
-- WHY. fro_live_status is ONE row per worker holding "today" counters, and it is
-- written monotonically (GREATEST) at every idle write path. There was no way to
-- tell which day those counters belonged to, and the day-rollover reset of
-- today_idle_seconds was conditional:
--
--     if (cleaned.idle_since === null && row.idle_since) payload.today_idle_seconds = 0;
--
-- i.e. the counters were only cleared if the worker happened to be sitting in an
-- OPEN idle period at the moment the new day was detected. A worker who ended the
-- previous day with idle_since = NULL (they had resumed, or signed out, or
-- commitIdleOnExit had banked the period) fell through the condition, and their
-- yesterday's committed total stayed in today_idle_seconds. The next day's idle
-- was then added on top of it, and the daily snapshot — itself written with
-- GREATEST, so it can never go down — captured the running total as a single
-- day's idle.
--
-- The result is arithmetically impossible figures: 52h19m and 45h14m of idle
-- recorded against 2026-09-14, the first day fro_daily_stats was ever written,
-- because that is the accumulated lifetime counter landing in one row at once.
-- It recurs mid-window too (Ravina Ambre 0h22m -> 21h21m on 2026-09-16), and
-- because every write uses GREATEST the inflated value is permanent.
--
-- Migration 126 assumed the browser panel reset these counters at midnight. It
-- stopped doing that when the server row became authoritative, and nothing
-- replaced the reset, so the assumption quietly stopped being true.
--
-- THE FIX. stats_date records the IST day the counters belong to. Any write path
-- that finds stats_date <> today snapshots the old counters against the OLD day
-- (so the previous day keeps its real total instead of being discarded) and
-- zeroes the live counters before adding today's. That makes the rollover
-- unconditional and independent of idle_since, which is what it always had to be.
--
-- Backfill from updated_at's IST date, which is the day the row was last written.
-- Rows that have never been written keep NULL and are treated as "today" by the
-- write paths, so an unwritten row is not misattributed to an arbitrary past day.

ALTER TABLE fro_live_status
  ADD COLUMN IF NOT EXISTS stats_date DATE;

UPDATE fro_live_status
   SET stats_date = (updated_at AT TIME ZONE 'Asia/Kolkata')::date
 WHERE stats_date IS NULL
   AND updated_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fro_live_status_stats_date ON fro_live_status (stats_date);
