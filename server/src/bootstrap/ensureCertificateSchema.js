import db from '../config/db.js';

// Certificate template management schema bootstrap — idempotent re-creation of
// the certificate_templates / certificate_template_fields / certificates tables
// (mirrors migration 118). Re-runs safely on every boot via CREATE TABLE IF NOT
// EXISTS, so a fresh or partially-migrated DB is repaired automatically.
export async function ensureCertificateSchema() {
  await db._pool.query(`CREATE TABLE IF NOT EXISTS certificate_templates (
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
     )`);

  await db._pool.query(`CREATE TABLE IF NOT EXISTS certificate_template_fields (
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
     )`);

  // History survives template deletion thanks to ON DELETE SET NULL + the
  // template_name/template_file snapshots stored on each generated certificate.
  await db._pool.query(`CREATE TABLE IF NOT EXISTS certificates (
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
     )`);

  // ngo_id must exactly match ngos.id's type for the FK, so adopt the live
  // column type (int4/int8/uuid) instead of hardcoding INT.
  const { rows: typeRows } = await db._pool.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t
     FROM pg_attribute a
     WHERE a.attrelid = 'ngos'::regclass AND a.attname = 'id'`
  );
  const ngoIdType = (typeRows[0] && typeRows[0].t) || 'bigint';

  const steps = [
    `ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS preview_image TEXT DEFAULT ''`,
    `ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS preview_key TEXT DEFAULT ''`,
    `ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS ngo_id ${ngoIdType} REFERENCES ngos(id) ON DELETE SET NULL`,
    `ALTER TABLE certificate_templates ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_cer_tpl_ngo ON certificate_templates (ngo_id)`,
    `CREATE INDEX IF NOT EXISTS idx_cer_tpl_purpose ON certificate_templates (purpose)`,
    `CREATE INDEX IF NOT EXISTS idx_cer_tpl_status ON certificate_templates (status)`,
    `CREATE INDEX IF NOT EXISTS idx_cer_fields_template ON certificate_template_fields (template_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_cer_fields_template_key ON certificate_template_fields (template_id, field_key)`,
    `CREATE INDEX IF NOT EXISTS idx_cer_certs_template ON certificates (template_id)`,
    `CREATE INDEX IF NOT EXISTS idx_cer_certs_number ON certificates (certificate_number)`,
    `CREATE INDEX IF NOT EXISTS idx_cer_certs_generated ON certificates (generated_at DESC)`,
  ];
  for (const sql of steps) {
    try { await db._pool.query(sql); } catch { /* index may already exist under a race; not fatal */ }
  }

  await db._pool.query(`CREATE TABLE IF NOT EXISTS certificate_purposes (
       id         BIGSERIAL PRIMARY KEY,
       name       TEXT NOT NULL,
       sort_order INT NOT NULL DEFAULT 0,
       is_active  BOOLEAN NOT NULL DEFAULT TRUE,
       created_at TIMESTAMPTZ DEFAULT NOW()
     )`);
  for (const [name, sort] of [['Appreciation certificate', 10], ['Achievement certificate', 20], ['Other', 30]]) {
    await db._pool.query(
      `INSERT INTO certificate_purposes (name, sort_order)
       SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM certificate_purposes WHERE name = $1)`,
      [name, sort]);
  }
}