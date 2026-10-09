-- 169: archive table for prior-month FRO call history.
--
-- froMonthlyRollover.js moves the previous month's non-financial disposition
-- logs here before deleting them, so the FRO History tab starts clean each month
-- while the full rows stay restorable by id.
--
-- This table is created by the service too (CREATE TABLE IF NOT EXISTS) so a
-- deploy that lands the service before this migration cannot throw inside the
-- 04:00 cron. Applying it here as well keeps the schema in version control.

CREATE TABLE IF NOT EXISTS public.fro_donor_logs_archive (
  archived_at            timestamptz      NOT NULL DEFAULT now(),
  archive_month          text             NOT NULL,
  id                     integer          NOT NULL,
  assignment_id          integer          NOT NULL,
  action                 text             NOT NULL,
  notes                  text,
  outcome                text,
  amount_collected       numeric(12,2),
  created_by             uuid,
  created_at             timestamptz      NOT NULL,
  disposition_category   text,
  disposition_detail     text,
  scheduled_at           timestamptz,
  payment_screenshot_url text,
  accounts_status        text,
  pan_number             text,
  verified_at            timestamptz,
  verified_by            uuid,
  donor_id               integer,
  fro_worker_id          uuid,
  remark                 text,
  upi_transaction_id     text,
  transaction_datetime   timestamptz,
  payment_from           text,
  payment_mode           text,
  rejection_reason       text
);

CREATE INDEX IF NOT EXISTS idx_fdl_archive_month
  ON public.fro_donor_logs_archive (archive_month);
CREATE INDEX IF NOT EXISTS idx_fdl_archive_assignment
  ON public.fro_donor_logs_archive (assignment_id);
CREATE INDEX IF NOT EXISTS idx_fdl_archive_donor
  ON public.fro_donor_logs_archive (donor_id);

COMMENT ON TABLE public.fro_donor_logs_archive IS
  'Full rows of prior-month non-financial FRO disposition logs, moved here by the '
  'monthly rollover. Donations, verified lead_done rows and any receipt parent are '
  'never moved. Restore with an explicit INSERT back into fro_donor_logs by id.';