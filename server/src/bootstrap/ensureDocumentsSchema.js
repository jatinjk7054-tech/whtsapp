import db from '../config/db.js';

// Documents columns — idempotent re-application of migrations 137 and 160.
//
// Same rationale as ensureSignatureSchema: migrations are not auto-run, so a
// fresh or partially-migrated database is repaired on boot via ADD COLUMN IF NOT
// EXISTS. This one matters more than most, because the write path names both
// columns explicitly in a single UPDATE (workerController writes documents_value
// and documents_other together), so a missing column fails the whole save with
//   column "documents_other" of relation "workers" does not exist
// rather than degrading quietly. Reads are unaffected — they all use
// select('*') — so the failure is invisible until someone actually saves.
//
// documents_value is included even though its migration (137) predates this
// file: it never had a hook, so a rebuilt or cloned database would fail on the
// older column once someone cleared their selection. Both statements are
// idempotent, so re-adding an existing column is free.
const COLUMN_STEPS = [
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS documents_value TEXT`,
  `ALTER TABLE workers ADD COLUMN IF NOT EXISTS documents_other TEXT`,
];

async function tableExists(name) {
  const r = await db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name]
  );
  return r.rows.length > 0;
}

export async function ensureDocumentsSchema() {
  if (!(await tableExists('workers'))) return;

  for (const sqlText of COLUMN_STEPS) {
    try {
      await db._pool.query(sqlText);
    } catch (e) {
      // Lost a race with a parallel boot, or the role cannot ALTER. Not fatal:
      // saving a document will report the missing column rather than the server
      // failing to start.
      console.warn('[documents schema] skip:', e?.message || String(e));
    }
  }
}
