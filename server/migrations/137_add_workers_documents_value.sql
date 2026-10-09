-- Migration 137: Store which education document the volunteer has submitted.
-- HR picks one value (10th / 12th / Degree / Others) from the profile card dropdown.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS documents_value TEXT;