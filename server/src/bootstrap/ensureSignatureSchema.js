import db from '../config/db.js';

// Signature durability + audit trail — idempotent re-application of migration 159.
//
// Same rationale as ensureTicketSchema: migrations are not auto-run, so a fresh
// or partially-migrated database is repaired on boot via ADD COLUMN IF NOT EXISTS.
// Without these columns the signature upload path fails outright, because the
// UPDATE writes signature_status alongside signature_url in a single statement.
//
// Also carries the one-time backfill that marks already-uploaded signatures as
// 'signed'. It is idempotent (only touches rows that are still NULL) and is safe
// to re-run — it never touches a row an admin has deliberately reset.

const COLUMN_STEPS = [
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_status    TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_signed_at TIMESTAMPTZ`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_ip        TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_source    TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_policy_id TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature_previous_url TEXT`,
];

const BACKFILL_STATUS = `
  UPDATE workers
     SET signature_status = 'signed'
   WHERE signature_url IS NOT NULL
     AND signature_status IS NULL
`;

async function tableExists(name) {
  const r = await db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rows.length > 0;
}

export async function ensureSignatureSchema() {
  if (!(await tableExists('workers'))) return;

  for (const sqlText of COLUMN_STEPS) {
    try {
      await db._pool.query(sqlText);
    } catch (e) {
      // Lost a race with a parallel boot, or the role cannot ALTER. Not fatal:
      // the signature endpoint degrades gracefully if the column is missing.
      console.warn('[signature schema] skip:', e?.message || String(e));
    }
  }

  try {
    const { rowCount } = await db._pool.query(BACKFILL_STATUS);
    if (rowCount) console.log(`[signature schema] marked ${rowCount} existing signature(s) as signed`);
  } catch (e) {
    console.warn('[signature schema] status backfill failed:', e?.message || String(e));
  }
}
