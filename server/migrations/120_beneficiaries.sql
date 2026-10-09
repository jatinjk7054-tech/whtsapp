-- ==========================================
-- BENEFICIARIES SYSTEM
-- Migration 120
-- ==========================================

-- Beneficiary Categories
CREATE TABLE IF NOT EXISTS beneficiary_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Beneficiaries (Master)
CREATE TABLE IF NOT EXISTS beneficiaries (
  id SERIAL PRIMARY KEY,
  beneficiary_code TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  date_of_birth DATE,
  gender TEXT,
  mobile TEXT,
  alternate_mobile TEXT,
  email TEXT,
  address_line_1 TEXT,
  address_line_2 TEXT,
  area TEXT,
  city TEXT,
  district TEXT,
  state TEXT,
  pincode TEXT,
  photo TEXT,
  monthly_family_income NUMERIC,
  income_category TEXT,
  bpl_available BOOLEAN DEFAULT false,
  ration_card_available BOOLEAN DEFAULT false,
  occupation TEXT,
  mother_name TEXT,
  father_name TEXT,
  guardian_name TEXT,
  guardian_occupation TEXT,
  total_family_members INT,
  status TEXT DEFAULT 'ACTIVE',
  ngo_id BIGINT,
  registration_date DATE DEFAULT CURRENT_DATE,
  fingerprint_status TEXT DEFAULT 'NOT_REGISTERED',
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Beneficiary-Category Assignment
CREATE TABLE IF NOT EXISTS beneficiary_category_assignments (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  category_id INT REFERENCES beneficiary_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(beneficiary_id, category_id)
);

-- Disability Details
CREATE TABLE IF NOT EXISTS beneficiary_disabilities (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  disability_type TEXT NOT NULL,
  disability_percentage NUMERIC,
  certificate_available BOOLEAN DEFAULT false,
  certificate_number TEXT,
  certificate_issue_date DATE,
  certificate_validity DATE,
  issuing_authority TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Family Members
CREATE TABLE IF NOT EXISTS beneficiary_family_members (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT,
  date_of_birth DATE,
  gender TEXT,
  occupation TEXT,
  mobile TEXT,
  is_dependent BOOLEAN DEFAULT false,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Education Details
CREATE TABLE IF NOT EXISTS beneficiary_education (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  education_level TEXT,
  currently_studying BOOLEAN DEFAULT false,
  school_or_institute TEXT,
  grade TEXT,
  course TEXT,
  special_skills TEXT,
  training_details TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Employment Details
CREATE TABLE IF NOT EXISTS beneficiary_employment (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  employment_status TEXT,
  occupation TEXT,
  employer TEXT,
  employment_type TEXT,
  monthly_income NUMERIC,
  skills TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Assistance Requirements
CREATE TABLE IF NOT EXISTS beneficiary_assistance_requirements (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  assistance_type TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'MEDIUM',
  status TEXT DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Documents
CREATE TABLE IF NOT EXISTS beneficiary_documents (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  file_url TEXT,
  file_name TEXT,
  document_number TEXT,
  verification_status TEXT DEFAULT 'PENDING',
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Source Records (historical import tracking)
CREATE TABLE IF NOT EXISTS beneficiary_source_records (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  source_type TEXT,
  source_file TEXT,
  source_sheet TEXT,
  source_row INT,
  source_record_number TEXT,
  source_case_number TEXT,
  original_name TEXT,
  original_data JSONB,
  import_batch_id INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Import Batches
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_url TEXT,
  total_rows INT DEFAULT 0,
  valid_rows INT DEFAULT 0,
  warning_rows INT DEFAULT 0,
  duplicate_rows INT DEFAULT 0,
  error_rows INT DEFAULT 0,
  status TEXT DEFAULT 'PENDING',
  imported_by TEXT,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Import Rows (staging)
CREATE TABLE IF NOT EXISTS import_rows (
  id SERIAL PRIMARY KEY,
  batch_id INT REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number INT,
  raw_data JSONB,
  mapped_data JSONB,
  status TEXT DEFAULT 'PENDING',
  validation_errors JSONB,
  beneficiary_id INT REFERENCES beneficiaries(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Beneficiary Cards (QR / RFID)
CREATE TABLE IF NOT EXISTS beneficiary_cards (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  card_type TEXT DEFAULT 'QR',
  card_number TEXT UNIQUE,
  qr_token TEXT UNIQUE,
  rfid_uid TEXT UNIQUE,
  status TEXT DEFAULT 'ACTIVE',
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  issued_by TEXT,
  replaced_at TIMESTAMPTZ,
  replacement_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Biometric Credentials
CREATE TABLE IF NOT EXISTS biometric_credentials (
  id SERIAL PRIMARY KEY,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  provider TEXT,
  device_type TEXT,
  device_name TEXT,
  device_id TEXT,
  credential_reference TEXT,
  finger_position TEXT,
  status TEXT DEFAULT 'ENROLLED',
  quality_score TEXT,
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  enrolled_by TEXT,
  last_verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add device_type/device_name to existing installations if missing
ALTER TABLE biometric_credentials
  ADD COLUMN IF NOT EXISTS device_type TEXT,
  ADD COLUMN IF NOT EXISTS device_name TEXT;

-- Programs (NGO Programs)
CREATE TABLE IF NOT EXISTS bnf_programs (
  id SERIAL PRIMARY KEY,
  program_code TEXT UNIQUE NOT NULL,
  ngo_id BIGINT,
  title TEXT NOT NULL,
  program_date DATE,
  start_time TEXT,
  end_time TEXT,
  description TEXT,
  location_id INT,
  location_name TEXT,
  status TEXT DEFAULT 'DRAFT',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Program Volunteer Requirements
CREATE TABLE IF NOT EXISTS program_volunteer_requirements (
  id SERIAL PRIMARY KEY,
  program_id INT REFERENCES bnf_programs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  volunteers_required INT DEFAULT 0,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Program Beneficiary Requirements
CREATE TABLE IF NOT EXISTS program_beneficiary_requirements (
  id SERIAL PRIMARY KEY,
  program_id INT REFERENCES bnf_programs(id) ON DELETE CASCADE,
  category_id INT REFERENCES beneficiary_categories(id),
  required_count INT DEFAULT 0,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Program Beneficiaries
CREATE TABLE IF NOT EXISTS program_beneficiaries (
  id SERIAL PRIMARY KEY,
  program_id INT REFERENCES bnf_programs(id) ON DELETE CASCADE,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE CASCADE,
  attendance_status TEXT DEFAULT 'REGISTERED',
  eligibility_status TEXT DEFAULT 'ELIGIBLE',
  service_status TEXT DEFAULT 'PENDING',
  checked_in_at TIMESTAMPTZ,
  checked_out_at TIMESTAMPTZ,
  checked_in_by TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(program_id, beneficiary_id)
);

-- Program Service Requirements
CREATE TABLE IF NOT EXISTS program_service_requirements (
  id SERIAL PRIMARY KEY,
  program_id INT REFERENCES bnf_programs(id) ON DELETE CASCADE,
  benefit_id INT,
  inventory_item_id INT,
  description TEXT,
  quantity_required INT DEFAULT 0,
  unit TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Program Additional Requirements
CREATE TABLE IF NOT EXISTS program_requirements (
  id SERIAL PRIMARY KEY,
  program_id INT REFERENCES bnf_programs(id) ON DELETE CASCADE,
  requirement_type TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'MEDIUM',
  status TEXT DEFAULT 'PENDING',
  assigned_to TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Program Volunteers
CREATE TABLE IF NOT EXISTS program_volunteers (
  id SERIAL PRIMARY KEY,
  program_id INT REFERENCES bnf_programs(id) ON DELETE CASCADE,
  volunteer_id INT,
  role TEXT,
  attendance_status TEXT DEFAULT 'ASSIGNED',
  check_in_time TIMESTAMPTZ,
  check_out_time TIMESTAMPTZ,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(program_id, volunteer_id)
);

-- NGO-specific Volunteers
CREATE TABLE IF NOT EXISTS bnf_volunteers (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  mobile TEXT,
  alternate_mobile TEXT,
  email TEXT,
  date_of_birth DATE,
  gender TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  photo TEXT,
  skills TEXT,
  availability TEXT,
  id_proof_type TEXT,
  id_proof_number TEXT,
  id_proof_url TEXT,
  status TEXT DEFAULT 'ACTIVE',
  ngo_id BIGINT,
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Benefits (configurable benefit types)
CREATE TABLE IF NOT EXISTS benefits (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Benefit Eligibility Rules
CREATE TABLE IF NOT EXISTS benefit_eligibility_rules (
  id SERIAL PRIMARY KEY,
  benefit_id INT REFERENCES benefits(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  rule_value TEXT NOT NULL,
  category_id INT REFERENCES beneficiary_categories(id),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Benefit Distributions
CREATE TABLE IF NOT EXISTS benefit_distributions (
  id SERIAL PRIMARY KEY,
  distribution_number TEXT UNIQUE NOT NULL,
  beneficiary_id INT REFERENCES beneficiaries(id),
  program_id INT REFERENCES bnf_programs(id),
  distributed_by TEXT,
  location_id INT,
  location_name TEXT,
  distribution_date TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'COMPLETED',
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Benefit Distribution Items
CREATE TABLE IF NOT EXISTS benefit_distribution_items (
  id SERIAL PRIMARY KEY,
  distribution_id INT REFERENCES benefit_distributions(id) ON DELETE CASCADE,
  benefit_id INT REFERENCES benefits(id),
  inventory_item_id INT,
  quantity INT DEFAULT 1,
  unit TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Beneficiary Audit Logs
CREATE TABLE IF NOT EXISTS beneficiary_audit_logs (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INT,
  beneficiary_id INT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB,
  performed_by TEXT,
  performed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Beneficiary Sequence Counter
CREATE TABLE IF NOT EXISTS beneficiary_sequences (
  id SERIAL PRIMARY KEY,
  current_value INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed initial sequence
INSERT INTO beneficiary_sequences (current_value) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM beneficiary_sequences);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_beneficiaries_code ON beneficiaries(beneficiary_code);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_status ON beneficiaries(status);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_name ON beneficiaries USING gin(to_tsvector('simple', full_name));
CREATE INDEX IF NOT EXISTS idx_beneficiaries_mobile ON beneficiaries(mobile);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_ngo ON beneficiaries(ngo_id);
CREATE INDEX IF NOT EXISTS idx_bnf_programs_date ON bnf_programs(program_date);
CREATE INDEX IF NOT EXISTS idx_bnf_programs_status ON bnf_programs(status);
CREATE INDEX IF NOT EXISTS idx_program_beneficiaries_program ON program_beneficiaries(program_id);
CREATE INDEX IF NOT EXISTS idx_program_beneficiaries_beneficiary ON program_beneficiaries(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_benefit_distributions_beneficiary ON benefit_distributions(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_benefit_distributions_program ON benefit_distributions(program_id);
CREATE INDEX IF NOT EXISTS idx_beneficiary_cards_qr ON beneficiary_cards(qr_token);
CREATE INDEX IF NOT EXISTS idx_beneficiary_cards_rfid ON beneficiary_cards(rfid_uid);
CREATE INDEX IF NOT EXISTS idx_biometric_beneficiary ON biometric_credentials(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_beneficiary_audit_beneficiary ON beneficiary_audit_logs(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_beneficiary_source_beneficiary ON beneficiary_source_records(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_bnf_volunteers_ngo ON bnf_volunteers(ngo_id);
CREATE INDEX IF NOT EXISTS idx_bnf_volunteers_status ON bnf_volunteers(status);

-- ------------------------------------------------------------------
-- FOREIGN KEYS → ngos
-- The ngos table may not exist (fresh deployments / isolated Query
-- Runners), and ngos.id's type is dynamic (int4/int8/uuid). The
-- beneficiaries / bnf_programs / bnf_volunteers tables declare a plain
-- ngo_id column. Only when ngos exists do we add the FK, adopting the
-- live ngos.id type so the constraint can be implemented. Type
-- conversion only happens when the column holds no data (fresh tables);
-- otherwise the FK is skipped so the migration never fails.
-- ------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  ngo_id_type TEXT;
  col_type TEXT;
  has_values BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'ngos') THEN
    SELECT format_type(a.atttypid, a.atttypmod) INTO ngo_id_type
    FROM pg_attribute a
    WHERE a.attrelid = 'ngos'::regclass AND a.attname = 'id';

    IF ngo_id_type IS NOT NULL THEN
      FOREACH t IN ARRAY ARRAY['beneficiaries', 'bnf_programs', 'bnf_volunteers'] LOOP
        IF to_regclass(t) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = t || '_ngo_id_fkey' AND conrelid = to_regclass(t)
          )
        THEN
          SELECT format_type(a.atttypid, a.atttypmod) INTO col_type
          FROM pg_attribute a
          WHERE a.attrelid = to_regclass(t) AND a.attname = 'ngo_id';

          IF col_type IS NULL THEN
            -- Column missing entirely — add it in the target type
            EXECUTE format('ALTER TABLE %I ADD COLUMN ngo_id %s', t, ngo_id_type);
          ELSIF col_type <> ngo_id_type THEN
            -- Only safe to retype when the table holds no non-null values
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE ngo_id IS NOT NULL)', t) INTO has_values;
            IF NOT has_values THEN
              EXECUTE format('ALTER TABLE %I ALTER COLUMN ngo_id TYPE %s USING NULL::%s', t, ngo_id_type, ngo_id_type);
            END IF;
          END IF;

          -- Add the FK only if the current column type now matches ngos.id
          IF EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = to_regclass(t) AND a.attname = 'ngo_id'
              AND format_type(a.atttypid, a.atttypmod) = ngo_id_type
          ) THEN
            EXECUTE format(
              'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (ngo_id) REFERENCES ngos(id) ON DELETE SET NULL',
              t, t || '_ngo_id_fkey'
            );
          END IF;
        END IF;
      END LOOP;
    END IF;
  END IF;
END $$;
