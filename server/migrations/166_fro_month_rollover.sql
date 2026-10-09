-- 166: fro_month_rollover_log — idempotency guard for the monthly FRO lead reset.
--
-- The monthly rollover resets worked leads (not_interested, call_disconnected,
-- ringing, busy, …) back to 'pending' so each billing month starts a fresh work
-- cycle for every FRO. That UPDATE touches ~105k rows, so it MUST NOT be able to
-- run twice: a double cron fire, a manual re-trigger, or two app instances
-- booting together would otherwise reset leads the FRO has already worked in the
-- new month.
--
-- This table is the claim. The service inserts the month_key FIRST and only
-- proceeds if that insert actually created a row (ON CONFLICT DO NOTHING). That
-- makes the claim atomic and single-winner: a second concurrent process sees a
-- conflict and exits without touching any data.
--
-- month_key is the IST billing month ("2026-11"), matching istMonthKey() and the
-- cycle_key month segment used by work_queue, so the rollover and the work
-- queue agree on what "this month" means.

create table if not exists public.fro_month_rollover_log (
  month_key   text primary key,
  ran_at      timestamptz not null default now(),
  -- 'retryable_only' = only not-connected/retryable statuses reset (refusals
  --                   are promoted to a permanent DND instead).
  -- 'all_but_dnd'   = every worked status resets except dnd / donation_collected.
  mode        text        not null,
  rows_reset  integer     not null default 0,
  rows_dnd    integer     not null default 0,
  -- Per-status counts, so a run can be audited after the fact without re-deriving.
  detail      jsonb,
  finished_at timestamptz
);

comment on table public.fro_month_rollover_log is
  'One row per IST billing month; the primary key is the atomic claim that stops the monthly FRO lead reset running twice.';
comment on column public.fro_month_rollover_log.detail is
  'Per-status reset/DND counts from the run, for audit.';