-- 163: HR daily reports — the hand-entered half of the Reports tab.
--
-- Numbered 163 rather than 162 because upstream master already ships
-- 162_audience_voting.sql; 162 would have been ambiguous in the numeric
-- ordering. 163 is taken by nothing. Same situation as the 159 -> 161
-- renumber in commit 6cd971f7. (There is no migration runner in this repo —
-- migrations are hand-applied SQL — so this is purely to keep the numbering
-- readable. Every statement below is idempotent, so re-applying is a no-op.)
--
-- HR > Reports is a hybrid screen: most of what it shows is derived live from
-- attendance, leaves and leads (those numbers are never written here), but a
-- few figures genuinely have no source in the database and must be typed by a
-- human each day:
--
--   absent_wopi   names marked Absent (WO-PI)  — paid absence
--   absent_wpi    names marked Absent (WPI)   — unpaid absence
--   terminations  people terminated that day
--   mis_manual    per-recruriter free text: calls made, candidates interested,
--                 remarks, handling roles/job posts. Keyed by recruiter id.
--
-- There is deliberately no `is_paid` column on `leaves` here. Paid vs unpaid
-- leave is tracked by typing the name into the WO-PI / WPI lists, which is the
-- workflow HR already uses on paper. Revisit only if that stops being workable.
--
-- `mis_manual` is keyed by recruiter **id**, not name: a recruiter rename would
-- otherwise orphan every historic entry under the old key.
--
-- One row per (report_date, reporter_name). A reporter fills in their own day
-- and owns it; a second reporter filling the same date gets their own row
-- rather than overwriting the first one's absences.

CREATE TABLE IF NOT EXISTS hr_daily_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date     DATE NOT NULL,
  reporter_name   TEXT NOT NULL,
  absent_wopi     TEXT,
  absent_wpi      TEXT,
  terminations    TEXT,
  -- { "<recruiter_uuid>": { calls_made, interested, remarks, handling } }
  mis_manual      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Text, not a users(id) FK: the JWT subject is written as a string everywhere
  -- else in this codebase (hr_whatsapp_sends.sent_by, receipts.created_by).
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT hr_daily_reports_date_reporter_key UNIQUE (report_date, reporter_name)
);

CREATE INDEX IF NOT EXISTS idx_hr_daily_reports_date
  ON hr_daily_reports (report_date DESC);

-- Keeps updated_at honest on writes that go through the query builder's
-- .update() (which does not set it automatically) as well as on upsert.
CREATE OR REPLACE FUNCTION hr_daily_reports_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_daily_reports_touch ON hr_daily_reports;
CREATE TRIGGER hr_daily_reports_touch
  BEFORE UPDATE ON hr_daily_reports
  FOR EACH ROW EXECUTE FUNCTION hr_daily_reports_touch_updated_at();
