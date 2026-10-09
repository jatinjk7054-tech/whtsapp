-- Own-system raw fingerprint storage (Path B).
-- Rows created by the app's raw USB capture flow are stored with
-- template_format='raw' and template_data = JSON:
--   { version, format:'raw', image (b64), template (b64 SourceAFIS), width, height, dpi, finger }
-- template_metadata mirrors the image geometry for cheap server-side filtering.
-- Legacy rows (UIDAI-encrypted PID blobs) keep template_format='legacy'.
ALTER TABLE biometric_credentials
  ADD COLUMN IF NOT EXISTS template_format TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE biometric_credentials
  ADD COLUMN IF NOT EXISTS template_metadata JSONB;