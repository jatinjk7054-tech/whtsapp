-- Preserve the device-generated fingerprint template separately from the
-- vendor PID envelope. Applications should encrypt this field at rest.
ALTER TABLE biometric_credentials
  ADD COLUMN IF NOT EXISTS template_data TEXT;
