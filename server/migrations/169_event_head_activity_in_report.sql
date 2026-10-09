-- 169: Event Head - "which activities are in my download" tick.
-- The monthly download used to list every programme every NGO planned that month,
-- so the file could not answer the only question the user had: "is this the set of
-- activities I actually wanted?". Ticking an activity is that decision, and it
-- belongs on the activity rather than on the month - an activity is either part of
-- how this NGO works or it is not, and once decided it applies to every month.
-- FALSE, not TRUE: the tick is opt-in, so nothing lands in a download until it has
-- been chosen. That is the opposite of the old behaviour on purpose - silently
-- including unticked activities is what made the file unreadable.
-- Boolean rather than a status enum: there are exactly two answers, and a
-- half-selected activity has no meaning.
-- No index: the planner already loads every activity for the NGO and filters in
-- memory, so nothing queries this column on its own.
-- Idempotent: safe to re-run.

ALTER TABLE event_head_activities
  ADD COLUMN IF NOT EXISTS in_report BOOLEAN NOT NULL DEFAULT FALSE;