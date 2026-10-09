import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/db.js';

// Idempotent re-application of migration 170 -- same rationale as
// ensureSignatureSchema and its siblings: migrations are not auto-run in this repo,
// and the code in leadModel.js depends on the constraint being in place.
//
// leadModel.js selects 'workers!leads_recruiter_id_fkey(name, email)'. PostgREST
// resolves that hint from the actual constraint definition, so while
// leads_recruiter_id_fkey still points at public.users the select either embeds the
// wrong table or errors outright. Shipping the JS without this having run means the
// lead list 500s for everybody, so it is applied on boot instead of being left in a
// .sql file somebody has to remember.
//
// The rules live in the .sql file, not here, so the migration and the boot path can
// never drift.

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../migrations/170_leads_recruiter_worker_fk.sql');

async function tableExists(name) {
  const r = await db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rows.length > 0;
}

/** Which table the constraint currently points at, for the boot log. */
async function currentFkTarget() {
  const { rows } = await db._pool.query(`
    SELECT c.confrelid::regclass::text AS target
      FROM pg_constraint c
     WHERE c.conrelid = 'public.leads'::regclass
       AND c.conname = 'leads_recruiter_id_fkey'
  `);
  return rows[0]?.target || null;
}

export async function ensureLeadsRecruiterFkSchema() {
  try {
    if (!(await tableExists('leads'))) return;
    if (!(await tableExists('workers'))) return;

    const before = await currentFkTarget();
    if (before === 'workers') return; // already correct; nothing to re-apply

    await db._pool.query(fs.readFileSync(MIGRATION, 'utf8'));

    const after = await currentFkTarget();
    if (after === 'workers') {
      console.log(
        `[lead ownership] leads.recruiter_id now references ${after}` +
          (before ? ` (was ${before})` : ''),
      );
    } else {
      // The migration ran but the constraint is not what it should be. leadModel.js
      // will fail on its embedded select until this is resolved, so it is worth a
      // line in the boot log rather than silence.
      console.warn(
        `[lead ownership] leads.recruiter_id_fkey is ${after || 'missing'}, expected workers; ` +
          'the lead list will fail until migration 170 is applied',
      );
    }
  } catch (e) {
    // Never stop the API from booting: most of it does not touch leads.
    console.warn('[lead ownership] skip:', e?.message || String(e));
  }
}
