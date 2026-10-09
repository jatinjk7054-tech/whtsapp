import db from '../config/db.js';

// Idempotent bootstrap for the per-month salary hold (Hold/Released) table.
// Accounts marks a worker's salary "held" for one month only; the default
// (no row) is "released", so the table only ever contains actively-held rows.
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS salary_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  salary_month TEXT NOT NULL,
  reason TEXT,
  held_by UUID REFERENCES workers(id) ON DELETE SET NULL,
  held_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(worker_id, salary_month)
);

CREATE INDEX IF NOT EXISTS idx_salary_holds_month ON salary_holds(salary_month);
`;

export async function ensureSalaryHoldSchema() {
  try {
    await db._pool.query(CREATE_TABLE_SQL);
    console.log('salary_holds table ready');
  } catch (e) {
    console.warn('[salary hold schema] skip:', e?.message || String(e));
  }
}