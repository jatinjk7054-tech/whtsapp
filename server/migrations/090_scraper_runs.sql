-- 090: AI Payment Scraper run logs (scrapper/ device app)
--   scraper_runs        - one row per device run (which phone/NGO, batch counts)
--   scraper_run_entries - per-transaction outcome so the accounts panel can show
--                         exactly what was imported / why a row was skipped.
-- Also guarantees a "Google Pay" option exists in the Received Bank (kind='bank')
-- and Mode of Payment (kind='mop') dropdowns.

CREATE TABLE IF NOT EXISTS scraper_runs (
  id                BIGSERIAL PRIMARY KEY,
  run_id            TEXT        NOT NULL UNIQUE,
  device_label      TEXT,
  project_id        TEXT,
  status            TEXT        NOT NULL DEFAULT 'running',
  transactions_seen INTEGER     NOT NULL DEFAULT 0,
  imported          INTEGER     NOT NULL DEFAULT 0,
  skipped           INTEGER     NOT NULL DEFAULT 0,
  errored           INTEGER     NOT NULL DEFAULT 0,
  error_message     TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scraper_run_entries (
  id               BIGSERIAL PRIMARY KEY,
  run_id           TEXT    NOT NULL,
  entry_id         BIGINT,
  payment_id       TEXT,
  amount           NUMERIC,
  payer_name       TEXT,
  transaction_date DATE,
  status           TEXT    NOT NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scraper_run_entries_run_id ON scraper_run_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_scraper_run_entries_payment_id ON scraper_run_entries(payment_id);
CREATE INDEX IF NOT EXISTS idx_scraper_runs_started_at ON scraper_runs(started_at DESC);

INSERT INTO bank_audit_sources (name, kind, is_active, sort_order)
VALUES ('Google Pay', 'bank', true, 99), ('Google Pay', 'mop', true, 99)
ON CONFLICT (name, kind) DO NOTHING;