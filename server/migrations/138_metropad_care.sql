-- ============================================================
-- MetroPad Care schema + seed data
-- Ported into the UCS_CRM database (no Supabase).
-- The metropad `users` table is renamed to `metropad_users` to
-- avoid colliding with the existing UCS `users` table.
-- Idempotent: safe to run repeatedly.
-- ============================================================

-- ============================================================
-- ENUM TYPES
-- ============================================================

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('ADMIN','OPERATIONS','VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE entity_status AS ENUM ('ACTIVE','INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE machine_status AS ENUM ('ACTIVE','INACTIVE','OFFLINE','MAINTENANCE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE issue_type AS ENUM ('MISSING_PADS','STOCK_MISMATCH','DAMAGED_PADS','DISPENSING_PROBLEM','WRONG_STOCK_COUNT','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE issue_status AS ENUM ('OPEN','INVESTIGATING','RESOLVED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE maintenance_priority AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE maintenance_status AS ENUM ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE monthly_machine_status AS ENUM ('WORKING','NOT_WORKING','MAINTENANCE','EMPTY','OTHER_ISSUE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE monthly_issue_type AS ENUM ('NONE','COIN_ACCEPTOR_PROBLEM','MACHINE_NOT_WORKING','DISPENSING_PROBLEM','ELECTRICAL_PROBLEM','STOCK_PROBLEM','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS metropad_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role user_role NOT NULL DEFAULT 'VIEWER',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metro_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL UNIQUE,
  description TEXT,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id UUID NOT NULL REFERENCES metro_lines(id) ON DELETE RESTRICT,
  station_code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  status entity_status NOT NULL DEFAULT 'ACTIVE',
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id VARCHAR(50) NOT NULL UNIQUE,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  line_id UUID NOT NULL REFERENCES metro_lines(id) ON DELETE RESTRICT,
  location VARCHAR(100),
  machine_type VARCHAR(50) DEFAULT 'Standard',
  capacity INT NOT NULL CHECK (capacity > 0),
  current_stock INT NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  low_stock_threshold INT NOT NULL DEFAULT 10,
  installation_date DATE,
  status machine_status NOT NULL DEFAULT 'ACTIVE',
  last_refill_at TIMESTAMPTZ,
  last_maintenance_at TIMESTAMPTZ,
  remark TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_stock <= capacity)
);

CREATE TABLE IF NOT EXISTS machine_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  previous_status machine_status NOT NULL,
  new_status machine_status NOT NULL,
  changed_by UUID REFERENCES metropad_users(id),
  reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refill_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  refill_date DATE NOT NULL,
  previous_stock INT NOT NULL CHECK (previous_stock >= 0),
  refill_quantity INT NOT NULL CHECK (refill_quantity >= 0),
  new_stock INT NOT NULL CHECK (new_stock >= 0),
  cash_collected NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (cash_collected >= 0),
  refilled_by VARCHAR(100) NOT NULL,
  remark TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (new_stock >= previous_stock)
);

ALTER TABLE refill_records
  ADD COLUMN IF NOT EXISTS cash_collected NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (cash_collected >= 0);

CREATE TABLE IF NOT EXISTS pad_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  record_date DATE NOT NULL,
  opening_stock INT NOT NULL DEFAULT 0,
  refilled_quantity INT NOT NULL DEFAULT 0,
  issues_count INT NOT NULL DEFAULT 0,
  missing_count INT NOT NULL DEFAULT 0,
  closing_stock INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(machine_id, record_date)
);

CREATE TABLE IF NOT EXISTS stock_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  report_date DATE NOT NULL,
  expected_stock INT NOT NULL CHECK (expected_stock >= 0),
  actual_stock INT NOT NULL CHECK (actual_stock >= 0),
  missing_quantity INT NOT NULL CHECK (missing_quantity >= 0),
  issue_type issue_type NOT NULL DEFAULT 'MISSING_PADS',
  reason TEXT,
  status issue_status NOT NULL DEFAULT 'OPEN',
  reported_by VARCHAR(100) NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(100),
  remark TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  problem TEXT NOT NULL,
  reported_date DATE NOT NULL,
  priority maintenance_priority NOT NULL DEFAULT 'MEDIUM',
  technician VARCHAR(100),
  status maintenance_status NOT NULL DEFAULT 'OPEN',
  resolved_date DATE,
  remark TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES metropad_users(id),
  user_name VARCHAR(100),
  action VARCHAR(100) NOT NULL,
  entity VARCHAR(50) NOT NULL,
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  record_date DATE NOT NULL,
  cash_collected NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cash_collected >= 0),
  remark TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(station_id, record_date)
);

CREATE TABLE IF NOT EXISTS monthly_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_date DATE NOT NULL,
  year_month VARCHAR(7) NOT NULL,
  line_id UUID NOT NULL REFERENCES metro_lines(id) ON DELETE RESTRICT,
  station_id UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE RESTRICT,
  cash_collected NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cash_collected >= 0),
  pads_refilled INT NOT NULL DEFAULT 0 CHECK (pads_refilled >= 0),
  machine_status monthly_machine_status NOT NULL DEFAULT 'WORKING',
  issue_type monthly_issue_type NOT NULL DEFAULT 'NONE',
  notes TEXT,
  next_action TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(machine_id, record_date)
);

CREATE TABLE IF NOT EXISTS stock_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key VARCHAR(50) NOT NULL UNIQUE,
  setting_value NUMERIC(12, 2) NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monthly_refill_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  year_month VARCHAR(7) NOT NULL,
  refill_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (refill_status IN ('COMPLETED','PENDING','UNABLE_TO_REFILL')),
  remark TEXT,
  created_by UUID REFERENCES metropad_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(machine_id, year_month)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_stations_line_id ON stations(line_id);
CREATE INDEX IF NOT EXISTS idx_machines_station_id ON machines(station_id);
CREATE INDEX IF NOT EXISTS idx_machines_line_id ON machines(line_id);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
CREATE INDEX IF NOT EXISTS idx_machines_machine_id ON machines(machine_id);
CREATE INDEX IF NOT EXISTS idx_machine_status_history_machine_id ON machine_status_history(machine_id);
CREATE INDEX IF NOT EXISTS idx_refill_records_machine_id ON refill_records(machine_id);
CREATE INDEX IF NOT EXISTS idx_refill_records_station_id ON refill_records(station_id);
CREATE INDEX IF NOT EXISTS idx_refill_records_refill_date ON refill_records(refill_date);
CREATE INDEX IF NOT EXISTS idx_pad_stock_machine_id ON pad_stock(machine_id);
CREATE INDEX IF NOT EXISTS idx_pad_stock_record_date ON pad_stock(record_date);
CREATE INDEX IF NOT EXISTS idx_stock_issues_machine_id ON stock_issues(machine_id);
CREATE INDEX IF NOT EXISTS idx_stock_issues_station_id ON stock_issues(station_id);
CREATE INDEX IF NOT EXISTS idx_stock_issues_report_date ON stock_issues(report_date);
CREATE INDEX IF NOT EXISTS idx_stock_issues_status ON stock_issues(status);
CREATE INDEX IF NOT EXISTS idx_maintenance_records_machine_id ON maintenance_records(machine_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_records_station_id ON maintenance_records(station_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_records_status ON maintenance_records(status);
CREATE INDEX IF NOT EXISTS idx_maintenance_records_reported_date ON maintenance_records(reported_date);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_cash_collections_station_id ON cash_collections(station_id);
CREATE INDEX IF NOT EXISTS idx_cash_collections_record_date ON cash_collections(record_date);
CREATE INDEX IF NOT EXISTS idx_monthly_data_year_month ON monthly_data(year_month);
CREATE INDEX IF NOT EXISTS idx_monthly_data_line_id ON monthly_data(line_id);
CREATE INDEX IF NOT EXISTS idx_monthly_data_station_id ON monthly_data(station_id);
CREATE INDEX IF NOT EXISTS idx_monthly_data_machine_id ON monthly_data(machine_id);
CREATE INDEX IF NOT EXISTS idx_monthly_data_record_date ON monthly_data(record_date);
CREATE INDEX IF NOT EXISTS idx_monthly_refill_status_machine ON monthly_refill_status(machine_id);
CREATE INDEX IF NOT EXISTS idx_monthly_refill_status_year_month ON monthly_refill_status(year_month);

-- ============================================================
-- SEED DATA
-- Users (real bcrypt hash — login works: Admin@1234)
-- ============================================================

INSERT INTO metropad_users (id, name, email, password_hash, role) VALUES
  ('a0000000-0000-0000-0000-000000000001','Admin User','admin@metropadcare.com','$2b$10$SVlaoUhwxF5p1mQ6t9EU1ewTqiYdPUUvY1xzzQFwM6euYfOlErKoG','ADMIN')
ON CONFLICT (id) DO NOTHING;

INSERT INTO stock_config (setting_key, setting_value, description) VALUES
  ('initial_stock', 10000, 'Total initial pad stock'),
  ('price_per_pad', 5, 'Price per pad in INR'),
  ('low_stock_threshold', 10, 'Global low stock threshold')
ON CONFLICT (setting_key) DO NOTHING;

-- ============================================================
-- METRO LINES
-- ============================================================

INSERT INTO metro_lines (id, code, name, description, status, created_by) VALUES
  ('b1000000-0000-0000-0000-000000000001','BL1','Blue Line 1','Versova–Andheri–Ghatkopar corridor','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002','RD1','Red Line 1','Dahisar–E–Mundhavas corridor','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000003','AQ1','Aqua Line 1','Colaba–Bandra–SEEPZ corridor','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000004','YL1','Yellow Line 1','Jawaharlal Nehru Road corridor','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000005','GN1','Green Line 1','Andheri East–MIDC corridor','ACTIVE','a0000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- STATIONS
-- ============================================================

INSERT INTO stations (id, line_id, station_code, name, description, status, created_by) VALUES
  -- Blue Line 1
  ('c1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','BL1-VRS','Versova','Versova metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','BL1-AND','Andheri','Andheri metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001','BL1-ADI','Andheri East','Andheri East metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001','BL1-GHP','Ghatkopar','Ghatkopar metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),

  -- Red Line 1
  ('c1000000-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000002','RD1-DHR','Dahisar East','Dahisar East metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000006','b1000000-0000-0000-0000-000000000002','RD1-MND','Mundhavas','Mundhavas metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000007','b1000000-0000-0000-0000-000000000002','RD1-BOR','Borivali','Borivali metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000008','b1000000-0000-0000-0000-000000000002','RD1-KLS','Kandivali','Kandivali metro station','INACTIVE','a0000000-0000-0000-0000-000000000001'),

  -- Aqua Line 1
  ('c1000000-0000-0000-0000-000000000009','b1000000-0000-0000-0000-000000000003','AQ1-CLB','Colaba','Colaba metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000010','b1000000-0000-0000-0000-000000000003','AQ1-BCD','Bandra','Bandra metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000011','b1000000-0000-0000-0000-000000000003','AQ1-SEP','SEEPZ','SEEPZ metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),

  -- Yellow Line 1
  ('c1000000-0000-0000-0000-000000000012','b1000000-0000-0000-0000-000000000004','YL1-WST','Worli','Worli metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000013','b1000000-0000-0000-0000-000000000004','YL1-LW','Lower Parel','Lower Parel metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),

  -- Green Line 1
  ('c1000000-0000-0000-0000-000000000014','b1000000-0000-0000-0000-000000000005','GN1-MID','MIDC Andheri','MIDC Andheri metro station','ACTIVE','a0000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000015','b1000000-0000-0000-0000-000000000005','GN1-JBS','Juhu Beach','Juhu Beach metro station','INACTIVE','a0000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- MACHINES
-- ============================================================

INSERT INTO machines (id, machine_id, station_id, line_id, location, machine_type, capacity, current_stock, low_stock_threshold, installation_date, status, last_refill_at, last_maintenance_at, created_by) VALUES
  -- Blue Line 1 — Versova
  ('d1000000-0000-0000-0000-000000000001','PAD-BL1-VRS-01','c1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','','Standard',50,38,10,'2024-06-15','ACTIVE','2026-09-05','2026-08-20','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000002','PAD-BL1-VRS-02','c1000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','','Compact',30,12,8,'2024-06-15','ACTIVE','2026-09-01','2026-07-15','a0000000-0000-0000-0000-000000000001'),

  -- Blue Line 1 — Andheri
  ('d1000000-0000-0000-0000-000000000003','PAD-BL1-AND-01','c1000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','Concourse','Standard',50,45,10,'2024-06-15','ACTIVE','2026-09-08','2026-08-10','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000004','PAD-BL1-AND-02','c1000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000001','','Compact',30,3,8,'2024-08-01','INACTIVE','2026-08-25','2026-09-01','a0000000-0000-0000-0000-000000000001'),

  -- Blue Line 1 — Andheri East
  ('d1000000-0000-0000-0000-000000000005','PAD-BL1-ADI-01','c1000000-0000-0000-0000-000000000003','b1000000-0000-0000-0000-000000000001','Concourse','Standard',50,22,10,'2024-06-15','ACTIVE','2026-09-03','2026-07-20','a0000000-0000-0000-0000-000000000001'),

  -- Blue Line 1 — Ghatkopar
  ('d1000000-0000-0000-0000-000000000006','PAD-BL1-GHP-01','c1000000-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001','','Standard',50,5,10,'2024-06-15','ACTIVE','2026-08-20','2026-09-05','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000007','PAD-BL1-GHP-02','c1000000-0000-0000-0000-000000000004','b1000000-0000-0000-0000-000000000001','','Standard',50,0,10,'2024-06-15','MAINTENANCE','2026-07-10','2026-09-08','a0000000-0000-0000-0000-000000000001'),

  -- Red Line 1 — Dahisar East
  ('d1000000-0000-0000-0000-000000000008','PAD-RD1-DHR-01','c1000000-0000-0000-0000-000000000005','b1000000-0000-0000-0000-000000000002','Concourse','Standard',50,42,10,'2024-07-01','ACTIVE','2026-09-07','2026-08-15','a0000000-0000-0000-0000-000000000001'),

  -- Red Line 1 — Mundhavas
  ('d1000000-0000-0000-0000-000000000009','PAD-RD1-MND-01','c1000000-0000-0000-0000-000000000006','b1000000-0000-0000-0000-000000000002','','Compact',30,18,8,'2024-07-01','ACTIVE','2026-09-04','2026-08-10','a0000000-0000-0000-0000-000000000001'),

  -- Red Line 1 — Borivali
  ('d1000000-0000-0000-0000-000000000010','PAD-RD1-BOR-01','c1000000-0000-0000-0000-000000000007','b1000000-0000-0000-0000-000000000002','Concourse','Standard',50,7,10,'2024-07-01','ACTIVE','2026-08-15','2026-09-02','a0000000-0000-0000-0000-000000000001'),

  -- Red Line 1 — Kandivali
  ('d1000000-0000-0000-0000-000000000011','PAD-RD1-KLS-01','c1000000-0000-0000-0000-000000000008','b1000000-0000-0000-0000-000000000002','Concourse','Standard',50,0,10,'2024-09-01','OFFLINE','2026-07-01','2026-07-15','a0000000-0000-0000-0000-000000000001'),

  -- Aqua Line 1 — Colaba
  ('d1000000-0000-0000-0000-000000000012','PAD-AQ1-CLB-01','c1000000-0000-0000-0000-000000000009','b1000000-0000-0000-0000-000000000003','','Standard',50,35,10,'2024-08-01','ACTIVE','2026-09-06','2026-08-25','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000013','PAD-AQ1-CLB-02','c1000000-0000-0000-0000-000000000009','b1000000-0000-0000-0000-000000000003','','Compact',30,28,8,'2024-08-01','ACTIVE','2026-09-08','2026-08-20','a0000000-0000-0000-0000-000000000001'),

  -- Aqua Line 1 — Bandra
  ('d1000000-0000-0000-0000-000000000014','PAD-AQ1-BCD-01','c1000000-0000-0000-0000-000000000010','b1000000-0000-0000-0000-000000000003','Concourse','Standard',50,15,10,'2024-08-01','ACTIVE','2026-09-02','2026-08-30','a0000000-0000-0000-0000-000000000001'),

  -- Aqua Line 1 — SEEPZ
  ('d1000000-0000-0000-0000-000000000015','PAD-AQ1-SEP-01','c1000000-0000-0000-0000-000000000011','b1000000-0000-0000-0000-000000000003','Concourse','Standard',50,48,10,'2024-08-01','ACTIVE','2026-09-09','2026-08-15','a0000000-0000-0000-0000-000000000001'),

  -- Yellow Line 1 — Worli
  ('d1000000-0000-0000-0000-000000000016','PAD-YL1-WST-01','c1000000-0000-0000-0000-000000000012','b1000000-0000-0000-0000-000000000004','Concourse','Standard',50,30,10,'2024-09-01','ACTIVE','2026-09-05','2026-08-28','a0000000-0000-0000-0000-000000000001'),

  -- Yellow Line 1 — Lower Parel
  ('d1000000-0000-0000-0000-000000000017','PAD-YL1-LWP-01','c1000000-0000-0000-0000-000000000013','b1000000-0000-0000-0000-000000000004','','Standard',50,40,10,'2024-09-01','ACTIVE','2026-09-07','2026-08-22','a0000000-0000-0000-0000-000000000001'),

  -- Green Line 1 — MIDC
  ('d1000000-0000-0000-0000-000000000018','PAD-GN1-MID-01','c1000000-0000-0000-0000-000000000014','b1000000-0000-0000-0000-000000000005','Concourse','Compact',30,20,8,'2024-10-01','ACTIVE','2026-09-06','2026-08-18','a0000000-0000-0000-0000-000000000001'),

  -- Green Line 1 — Juhu Beach
  ('d1000000-0000-0000-0000-000000000019','PAD-GN1-JBS-01','c1000000-0000-0000-0000-000000000015','b1000000-0000-0000-0000-000000000005','Concourse','Standard',50,0,10,'2024-10-01','OFFLINE','2026-06-15','2026-06-20','a0000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- MACHINE STATUS HISTORY
-- ============================================================

INSERT INTO machine_status_history (machine_id, previous_status, new_status, changed_by, reason, changed_at) VALUES
  ('d1000000-0000-0000-0000-000000000004','ACTIVE','INACTIVE','a0000000-0000-0000-0000-000000000001','Machine malfunction — coin slot jammed','2026-08-28 10:30:00+05:30'),
  ('d1000000-0000-0000-0000-000000000007','ACTIVE','MAINTENANCE','a0000000-0000-0000-0000-000000000001','Dispenser belt broken — needs replacement','2026-09-08 14:15:00+05:30'),
  ('d1000000-0000-0000-0000-000000000011','INACTIVE','OFFLINE','a0000000-0000-0000-0000-000000000001','Station closed for renovation','2026-07-15 09:00:00+05:30'),
  ('d1000000-0000-0000-0000-000000000019','MAINTENANCE','OFFLINE','a0000000-0000-0000-0000-000000000001','Pending spare parts','2026-06-20 11:45:00+05:30')
ON CONFLICT DO NOTHING;

-- ============================================================
-- REFILL RECORDS (July–September 2026)
-- ============================================================

INSERT INTO refill_records (machine_id, station_id, refill_date, previous_stock, refill_quantity, new_stock, refilled_by, remark, created_by) VALUES
  -- July
  ('d1000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','2026-07-05',25,20,45,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000002','2026-07-05',30,20,50,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000003','2026-07-08',18,22,40,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000006','c1000000-0000-0000-0000-000000000004','2026-07-08',22,18,40,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000008','c1000000-0000-0000-0000-000000000005','2026-07-10',28,17,45,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000012','c1000000-0000-0000-0000-000000000009','2026-07-12',20,25,45,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000016','c1000000-0000-0000-0000-000000000012','2026-07-15',15,20,35,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),

  -- August
  ('d1000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','2026-08-05',30,15,45,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001','2026-08-05',8,15,23,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000002','2026-08-06',35,15,50,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000003','2026-08-08',20,18,38,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000008','c1000000-0000-0000-0000-000000000005','2026-08-10',32,13,45,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000009','c1000000-0000-0000-0000-000000000006','2026-08-10',10,15,25,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000012','c1000000-0000-0000-0000-000000000009','2026-08-12',30,10,40,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000014','c1000000-0000-0000-0000-000000000010','2026-08-15',8,22,30,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000016','c1000000-0000-0000-0000-000000000012','2026-08-18',18,17,35,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000018','c1000000-0000-0000-0000-000000000014','2026-08-20',10,12,22,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),

  -- September
  ('d1000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','2026-09-05',30,8,38,'Riya Sharma','Top-up refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001','2026-09-01',15,0,15,'Riya Sharma','Not enough space for full refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000002','2026-09-08',40,5,45,'Riya Sharma','Top-up refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000003','2026-09-03',28,0,28,'Riya Sharma','Stock OK — no refill needed','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000006','c1000000-0000-0000-0000-000000000004','2026-08-20',5,0,5,'Riya Sharma','Machine under repair — pending','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000008','c1000000-0000-0000-0000-000000000005','2026-09-07',35,7,42,'Riya Sharma','Top-up refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000009','c1000000-0000-0000-0000-000000000006','2026-09-04',12,6,18,'Riya Sharma','Top-up refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000010','c1000000-0000-0000-0000-000000000007','2026-09-02',3,4,7,'Riya Sharma','Low stock — emergency refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000012','c1000000-0000-0000-0000-000000000009','2026-09-06',28,7,35,'Riya Sharma','Top-up refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000013','c1000000-0000-0000-0000-000000000009','2026-09-08',20,8,28,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000014','c1000000-0000-0000-0000-000000000010','2026-09-02',5,10,15,'Riya Sharma','Emergency refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000015','c1000000-0000-0000-0000-000000000011','2026-09-09',42,6,48,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000016','c1000000-0000-0000-0000-000000000012','2026-09-05',22,8,30,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000017','c1000000-0000-0000-0000-000000000013','2026-09-07',30,10,40,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000018','c1000000-0000-0000-0000-000000000014','2026-09-06',10,10,20,'Riya Sharma','Monthly refill','a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ============================================================
-- STOCK ISSUES
-- ============================================================

INSERT INTO stock_issues (machine_id, station_id, report_date, expected_stock, actual_stock, missing_quantity, issue_type, reason, status, reported_by, remark, created_by) VALUES
  ('d1000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','2026-07-20',40,35,5,'MISSING_PADS','Possible theft or dispensing error','INVESTIGATING','Riya Sharma','CCTV review pending','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000002','2026-08-15',48,42,6,'STOCK_MISMATCH','Sensor count mismatch','RESOLVED','Riya Sharma','Sensor recalibrated','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000008','c1000000-0000-0000-0000-000000000005','2026-09-01',42,38,4,'MISSING_PADS','Customer reported missing pad','OPEN','Riya Sharma','Under investigation','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000012','c1000000-0000-0000-0000-000000000009','2026-08-28',40,37,3,'DAMAGED_PADS','3 pads found damaged in machine','RESOLVED','Riya Sharma','Damaged pads replaced','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000016','c1000000-0000-0000-0000-000000000012','2026-09-08',32,30,2,'WRONG_STOCK_COUNT','Counter showed incorrect number','OPEN','Riya Sharma','System audit needed','a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ============================================================
-- MAINTENANCE RECORDS
-- ============================================================

INSERT INTO maintenance_records (machine_id, station_id, problem, reported_date, priority, technician, status, resolved_date, remark, created_by) VALUES
  ('d1000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000002','Coin slot jammed — cannot accept payment','2026-08-28','HIGH','Suresh Kumar','IN_PROGRESS',NULL,'Awaiting coin mechanism replacement','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000007','c1000000-0000-0000-0000-000000000004','Dispenser belt broken — pads not dispensing','2026-09-08','CRITICAL','Rahul Mehta','OPEN',NULL,'Spare parts ordered','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000011','c1000000-0000-0000-0000-000000000008','Station under renovation — all machines offline','2026-07-15','LOW',NULL,'IN_PROGRESS',NULL,'Expected to reopen October 2026','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000019','c1000000-0000-0000-0000-000000000015','Machine offline — power supply issue','2026-06-20','HIGH',NULL,'OPEN',NULL,'Station still under construction','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000006','c1000000-0000-0000-0000-000000000004','Touch screen unresponsive','2026-09-05','MEDIUM','Suresh Kumar','ASSIGNED',NULL,'Technician dispatched','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000010','c1000000-0000-0000-0000-000000000007','Low stock alert — emergency refill needed','2026-09-02','HIGH','Riya Sharma','RESOLVED','2026-09-02','Emergency refill completed — 4 pads added','a0000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000003','Periodic maintenance check','2026-08-10','LOW','Rahul Mehta','RESOLVED','2026-08-12','All systems functional','a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- ============================================================
-- PAD STOCK LEDGER (one row per machine per active day — simplified)
-- ============================================================

INSERT INTO pad_stock (machine_id, record_date, opening_stock, refilled_quantity, issues_count, missing_count, closing_stock) VALUES
  -- September 2026 entries
  ('d1000000-0000-0000-0000-000000000001','2026-09-01',30,0,0,0,30),
  ('d1000000-0000-0000-0000-000000000001','2026-09-05',30,8,0,0,38),
  ('d1000000-0000-0000-0000-000000000002','2026-09-01',15,0,0,0,12),
  ('d1000000-0000-0000-0000-000000000003','2026-09-08',40,5,0,0,45),
  ('d1000000-0000-0000-0000-000000000005','2026-09-03',28,0,0,0,22),
  ('d1000000-0000-0000-0000-000000000008','2026-09-01',35,7,0,4,38),
  ('d1000000-0000-0000-0000-000000000009','2026-09-04',12,6,0,0,18),
  ('d1000000-0000-0000-0000-000000000010','2026-09-02',3,4,0,0,7),
  ('d1000000-0000-0000-0000-000000000012','2026-09-01',28,7,3,0,35),
  ('d1000000-0000-0000-0000-000000000013','2026-09-08',20,8,0,0,28),
  ('d1000000-0000-0000-0000-000000000014','2026-09-02',5,10,0,0,15),
  ('d1000000-0000-0000-0000-000000000015','2026-09-09',42,6,0,0,48),
  ('d1000000-0000-0000-0000-000000000016','2026-09-05',22,8,2,0,30),
  ('d1000000-0000-0000-0000-000000000017','2026-09-07',30,10,0,0,40),
  ('d1000000-0000-0000-0000-000000000018','2026-09-06',10,10,0,0,20)
ON CONFLICT (machine_id, record_date) DO NOTHING;