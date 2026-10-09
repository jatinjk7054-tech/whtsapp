-- 094: Enforce same-day disposition suppression on work_queue at the DB layer.
--
-- Business rule: if a donor already has ANY disposition TODAY (IST) for THIS
-- worker, that donor must NOT become selectable (PENDING / IN_PROGRESS /
-- BUTTON_PRESSED) again today — even for a retryable disposition (ringing/busy).
-- Tomorrow, retryability is recalculated by the existing rules.
--
-- This is a safety net so that no future code path can accidentally resurrect a
-- donor disposed earlier today. Scope is per worker (work_queue.worker_id) +
-- donor (work_queue.donor_id); disposing a donor under FRO-1 never blocks it
-- for FRO-2.
--
-- Applied by the user via Query Runner (DB is not reachable from the app host).

-- ------- drop any prior version of this trigger/function (idempotent) -------
DROP TRIGGER IF EXISTS trg_fro_queue_same_day_suppress ON work_queue;
DROP FUNCTION IF EXISTS uq_fro_queue_same_day_suppress_guard();

CREATE OR REPLACE FUNCTION uq_fro_queue_same_day_suppress_guard()
RETURNS trigger AS $$
DECLARE
  today_start timestamptz;
  today_end   timestamptz;
BEGIN
  -- Only care when a row is being (re)activated.
  IF NEW.status IN ('PENDING','IN_PROGRESS','BUTTON_PRESSED') THEN
    -- IST day bounds (matches backend/utils/ist.js istDayBounds()).
    today_start := date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata')
                     AT TIME ZONE 'Asia/Kolkata';
    today_end   := today_start + interval '1 day';

    IF EXISTS (
      SELECT 1 FROM fro_donor_logs l
      WHERE l.donor_id = NEW.donor_id
        AND l.fro_worker_id = NEW.worker_id
        AND l.action = 'disposition'
        AND l.created_at >= today_start
        AND l.created_at <  today_end
    ) THEN
      -- Force the row terminal/DISPOSED so the donor stays out today.
      NEW.status := 'DISPOSED';
      IF NEW.disposed_at IS NULL THEN
        NEW.disposed_at := now();
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_fro_queue_same_day_suppress
  BEFORE INSERT OR UPDATE OF status ON work_queue
  FOR EACH ROW
  EXECUTE FUNCTION uq_fro_queue_same_day_suppress_guard();
