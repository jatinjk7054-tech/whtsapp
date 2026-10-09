-- 126: FRO daily activity snapshot
--
-- The FRO panel keeps its counters in the browser keyed by IST date, so
-- today_idle_seconds (and talk/break/call counters) reset to 0 every day at
-- midnight and the previous day's values are otherwise lost. That makes a
-- monthly/yearly idle total impossible.
--
-- fro_daily_stats stores the running per-day total so the daily view can keep
-- starting from 0 today while month/year filters can SUM() across dates.
-- One row per (worker_id, stat_date); updated on every heartbeat with the max
-- value observed, since the kept counters only ever grow within a day.
--
--   - worker_id     FK → workers.id
--   - stat_date     IST calendar date (date in server is already IST via pool)
--   - idle_seconds  greatest observed today_idle_seconds that day
--   - talk_seconds  greatest observed today_talk_seconds that day
--   - break_seconds greatest observed today_break_seconds that day
--   - calls         greatest observed today_calls that day
--   - skipped       greatest observed today_skipped that day

CREATE TABLE IF NOT EXISTS fro_daily_stats (
  worker_id     UUID NOT NULL REFERENCES workers(id),
  stat_date     DATE NOT NULL,
  idle_seconds  INTEGER NOT NULL DEFAULT 0,
  talk_seconds  INTEGER NOT NULL DEFAULT 0,
  break_seconds INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_fro_daily_stats_date ON fro_daily_stats (stat_date);