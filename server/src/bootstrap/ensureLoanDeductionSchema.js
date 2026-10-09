import db from '../config/db.js';

// Idempotent bootstrap for the worker_loan_deductions table. Ensures the table
// exists on server start so loan/advance monthly settlement (see
// loanModel.settleMonthlyLoanDeductions) never fails on a fresh DB.
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS worker_loan_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES worker_loans(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(loan_id, month)
)
`;

export async function ensureLoanDeductionSchema() {
  try {
    await db._pool.query(CREATE_TABLE_SQL);
    console.log('worker_loan_deductions table ready');
  } catch (e) {
    console.warn('[loan deduction schema] skip:', e?.message || String(e));
  }
  try {
    await db._pool.query(`ALTER TABLE worker_loans ADD COLUMN IF NOT EXISTS start_month DATE`);
    await db._pool.query(`ALTER TABLE worker_loans ADD COLUMN IF NOT EXISTS end_month DATE`);
    await db._pool.query(`ALTER TABLE worker_loans ADD COLUMN IF NOT EXISTS recurring BOOLEAN DEFAULT FALSE`);
    console.log('worker_loans period columns ready');
  } catch (e) {
    console.warn('[loan period columns] skip:', e?.message || String(e));
  }
  // Ensure worker_loan_deductions.loan_id FK cascades on loan delete. Older DBs
  // created the table without ON DELETE CASCADE, so deleting a loan with
  // deduction rows raises a FK violation. Drop + re-add the FK idempotently so
  // re-running the bootstrap is a safe no-op.
  try {
    await db._pool.query(`
      ALTER TABLE worker_loan_deductions
        DROP CONSTRAINT IF EXISTS worker_loan_deductions_loan_id_fkey
    `);
    await db._pool.query(`
      ALTER TABLE worker_loan_deductions
        ADD CONSTRAINT worker_loan_deductions_loan_id_fkey
        FOREIGN KEY (loan_id) REFERENCES worker_loans(id) ON DELETE CASCADE
    `);
    console.log('worker_loan_deductions FK cascade ensured');
  } catch (e) {
    console.warn('[loan deduction FK cascade] skip:', e?.message || String(e));
  }
  // 'overdue' is a terminal-but-still-owed status: the term has fully elapsed with
  // a balance left, so the loan can no longer be auto-deducted from salary. Older
  // DBs constrain status to {pending,approved,rejected,active,closed}, which makes
  // every attempt to retire an expired loan fail with a check violation and leaves
  // it stuck on 'active' forever. Re-point the constraint at the full set; the
  // values are additive so no existing row is invalidated.
  try {
    await db._pool.query(`
      ALTER TABLE worker_loans DROP CONSTRAINT IF EXISTS worker_loans_status_check
    `);
    await db._pool.query(`
      ALTER TABLE worker_loans
        ADD CONSTRAINT worker_loans_status_check
        CHECK (status IS NULL OR status = ANY (ARRAY[
          'pending','approved','rejected','active','closed','overdue'
        ]))
    `);
    console.log("worker_loans status constraint now allows 'overdue'");
  } catch (e) {
    console.warn('[loan status constraint] skip:', e?.message || String(e));
  }
}