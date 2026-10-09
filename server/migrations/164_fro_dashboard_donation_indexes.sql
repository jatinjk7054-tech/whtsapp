-- Indexes for the FRO dashboard's hot donation queries.
--
-- The dashboard read fro_donor_logs joined to fro_assignments filtered on
-- action/accounts_status/created_at, but no index led with those columns, so
-- Postgres chose a sequential scan: 41 billion rows read via seq_scan across
-- 662k scans, and one query alone returned 3.3 billion rows cumulatively
-- (434ms average over 26.5k calls). That was the dashboard's loading spinner.
--
-- idx_fdl_donation_verified_created is partial, so it only carries the rows
-- the "donation + verified" aggregate actually asks for, and stays small as the
-- table grows with the other actions filtered out.
--
-- idx_fro_assignments_ngo_id supports the ngo_id side of the join that every
-- one of these queries filters on.

create index if not exists idx_fdl_donation_verified_created
  on public.fro_donor_logs (created_at)
  where action = 'donation' and accounts_status = 'verified';

create index if not exists idx_fdl_action_status_created
  on public.fro_donor_logs (action, accounts_status, created_at);

create index if not exists idx_fro_assignments_ngo_id
  on public.fro_assignments (ngo_id, station);

analyze public.fro_donor_logs;
analyze public.fro_assignments;

-- public.delete_agent() deleted the worker's notification_log rows as part of
-- removing the user. The table is retired, so that statement would fail the
-- whole RPC and block the user deletion; the function no longer touches it.
--
-- (Applied to the live database alongside the table drop.)
