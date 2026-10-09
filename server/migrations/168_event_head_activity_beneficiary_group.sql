-- 168: Event Head — beneficiary group per activity.
-- An activity is a recurring programme type (NGO → Sector → Activity), so it
-- carried no idea of *who* it serves. That made two things impossible:
--   1. filtering a month's activities by beneficiary group in the Monthly Planner
--      (Visually Impaired / Women / Persons with Disabilities, per NGO), and
--   2. telling the AI which group an activity is for, so its programme ideas
--      were generic instead of aimed at that group's needs.
-- Deliberately free TEXT rather than a lookup table: the groups are the NGOs'
-- own vocabulary, they differ per NGO, and the planner derives its filter
-- options from whatever values are actually in use. No taxonomy to maintain.
-- Nullable on purpose: an existing activity with no group stays valid and is
-- simply untagged (it still appears under the "All" filter).
-- Idempotent: safe to re-run.

ALTER TABLE event_head_activities
  ADD COLUMN IF NOT EXISTS beneficiary_group TEXT;

-- The planner's Beneficiary filter lists the distinct groups in use, so this
-- partial index covers the only pattern that is ever queried.
CREATE INDEX IF NOT EXISTS idx_event_head_activities_beneficiary_group
  ON event_head_activities (beneficiary_group)
  WHERE beneficiary_group IS NOT NULL AND btrim(beneficiary_group) <> '';