-- Migration 129: Add documents_submitted flag to workers.
-- HR toggles this Yes/No when the volunteer hands over their documents.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS documents_submitted boolean NOT NULL DEFAULT false;
