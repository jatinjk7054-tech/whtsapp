-- 092: Event Head — multi-activity per event.
-- Adds a join table so an event can reference MULTIPLE activities while keeping
-- the existing single `activity_id` column as the "primary" activity so all
-- current pages (Events list/detail/dashboard/import/export) keep working.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS event_head_event_activities (
  event_id    INT NOT NULL REFERENCES event_head_events(id) ON DELETE CASCADE,
  activity_id INT NOT NULL REFERENCES event_head_activities(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_event_head_event_activities_activity
  ON event_head_event_activities (activity_id);

-- Backfill: seed the join table from the existing single activity_id so no
-- historical data is lost and old events still show their activity.
INSERT INTO event_head_event_activities (event_id, activity_id)
SELECT e.id, e.activity_id
FROM event_head_events e
WHERE e.activity_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM event_head_event_activities ea
    WHERE ea.event_id = e.id AND ea.activity_id = e.activity_id
  );
