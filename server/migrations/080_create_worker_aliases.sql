-- Variant spellings of FRO names on imported receipts (e.g. "Ravina Jain" vs
-- "Ravina  Jain", "Sushma Ambokar" vs "Sushma Narendra Ambokar") previously
-- failed name resolution, so those donations were never credited. This table
-- maps known printed-name variants to their canonical worker.
CREATE TABLE IF NOT EXISTS worker_aliases (
  id bigserial PRIMARY KEY,
  alias_name text NOT NULL,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_aliases_alias ON worker_aliases (lower(alias_name));
CREATE INDEX IF NOT EXISTS idx_worker_aliases_worker ON worker_aliases(worker_id);
