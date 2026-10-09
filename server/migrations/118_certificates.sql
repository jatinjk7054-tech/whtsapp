-- Certificate template management & generator (mirrors src/bootstrap/ensureCertificateSchema.js)
-- Idempotent. Run manually on staging/dev if the bootstrap did not apply it.

ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS preview_image TEXT DEFAULT '';
ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS preview_key TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS certificate_templates (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  file_format TEXT NOT NULL DEFAULT 'docx',
  status      TEXT NOT NULL DEFAULT 'active',
  template_file TEXT NOT NULL DEFAULT '',
  template_key TEXT NOT NULL DEFAULT '',
  preview_image TEXT DEFAULT '',
  preview_key TEXT DEFAULT '',
  placeholders JSONB NOT NULL DEFAULT '[]'::jsonb,
  version     INT NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificate_template_fields (
  id           BIGSERIAL PRIMARY KEY,
  template_id  BIGINT NOT NULL REFERENCES certificate_templates(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,
  display_name TEXT NOT NULL,
  field_type   TEXT NOT NULL DEFAULT 'text',
  required     BOOLEAN NOT NULL DEFAULT TRUE,
  default_value TEXT DEFAULT '',
  in_template  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificates (
  id                BIGSERIAL PRIMARY KEY,
  template_id       BIGINT REFERENCES certificate_templates(id) ON DELETE SET NULL,
  template_name     TEXT,
  template_version  INT,
  template_file     TEXT,
  certificate_number TEXT,
  recipient_name    TEXT,
  field_values      JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_file    TEXT NOT NULL DEFAULT '',
  generated_by      TEXT,
  generated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cer_tpl_status ON certificate_templates (status);
CREATE INDEX IF NOT EXISTS idx_cer_fields_template ON certificate_template_fields (template_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cer_fields_template_key ON certificate_template_fields (template_id, field_key);
CREATE INDEX IF NOT EXISTS idx_cer_certs_template ON certificates (template_id);
CREATE INDEX IF NOT EXISTS idx_cer_certs_number ON certificates (certificate_number);
CREATE INDEX IF NOT EXISTS idx_cer_certs_generated ON certificates (generated_at DESC);