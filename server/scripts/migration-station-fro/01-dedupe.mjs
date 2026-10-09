// D1: collapse duplicate active (ngo_id, donor_id) rows in fro_assignments.
//
// Survivor rule (in order): most logs -> most scheduled contacts -> oldest
// assigned_at -> lowest id.  The survivor therefore always holds the record
// with the donor's operational/history data.
//
// Before deleting anything we (a) copy the latest non-NULL loser follow-up onto
// survivors that have none, and (b) re-point fro_donor_logs and
// fro_scheduled_contacts at the survivor.  followup_buckets is a VIEW over
// fro_assignments so it is never written to directly; it resolves itself once
// the losers are gone.
import pg from 'pg';

const DSN =
  process.env.DATABASE_URL ||
  'postgres://ucs_admin:ucscompany123@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/postgres';

const APPLY = process.argv.includes('--apply');

const BUILD_LOSERS = `
  WITH stats AS (
    SELECT a.id, a.ngo_id, a.donor_id, a.next_follow_up, a.assigned_at,
           coalesce(l.logs, 0) AS logs,
           coalesce(s.sc, 0)   AS sc
    FROM fro_assignments a
    LEFT JOIN (
      SELECT assignment_id, count(*) AS logs
      FROM fro_donor_logs GROUP BY assignment_id
    ) l ON l.assignment_id = a.id
    LEFT JOIN (
      SELECT assignment_id, count(*) AS sc
      FROM fro_scheduled_contacts GROUP BY assignment_id
    ) s ON s.assignment_id = a.id
    WHERE a.status <> 'reassigned'
  ),
  dupe AS (
    SELECT ngo_id, donor_id
    FROM stats
    GROUP BY ngo_id, donor_id
    HAVING count(*) > 1
  ),
  ranked AS (
    SELECT st.*,
           row_number() OVER (
             PARTITION BY st.ngo_id, st.donor_id
             ORDER BY st.logs DESC, st.sc DESC,
                      st.assigned_at ASC NULLS LAST, st.id ASC
           ) AS rn,
           first_value(st.id) OVER (
             PARTITION BY st.ngo_id, st.donor_id
             ORDER BY st.logs DESC, st.sc DESC,
                      st.assigned_at ASC NULLS LAST, st.id ASC
           ) AS survivor_id
    FROM stats st
    JOIN dupe d ON d.ngo_id = st.ngo_id AND d.donor_id = st.donor_id
  )
  SELECT id AS loser_id, survivor_id, ngo_id, donor_id,
         next_follow_up AS loser_followup
  FROM ranked
  WHERE rn > 1`;

async function main() {
  const client = new pg.Client({ connectionString: DSN, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // ---- preflight: confirm which FKs point at fro_assignments ----
  const fks = await client.query(`
    SELECT tc.table_name, kcu.column_name, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'fro_assignments'
      AND tc.table_schema = 'public'`);
  console.log('FKs referencing fro_assignments:');
  for (const fk of fks.rows) console.log('  ', JSON.stringify(fk));

  const orphansBefore = await client.query(`
    SELECT
      (SELECT count(*) FROM fro_donor_logs
        WHERE assignment_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fro_assignments a WHERE a.id = fro_donor_logs.assignment_id)) AS logs,
      (SELECT count(*) FROM fro_scheduled_contacts
        WHERE assignment_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fro_assignments a WHERE a.id = fro_scheduled_contacts.assignment_id)) AS sc`);
  console.log('orphan refs BEFORE:', JSON.stringify(orphansBefore.rows[0]));

  // ---- analysis (no writes yet) ----
  const dd = await client.query(BUILD_LOSERS);
  const losers = dd.rows;
  console.log(`loser rows identified: ${losers.length}`);
  if (losers.length === 0) {
    console.log('nothing to do');
    await client.end();
    return;
  }

  const withFollowup = losers.filter(l => l.loser_followup !== null);
  console.log(`losers carrying a next_follow_up: ${withFollowup.length}`);
  const survivorsNeedFollowup = new Set(
    withFollowup.filter(l => true).map(l => l.survivor_id)
  );
  console.log(`distinct survivors that could receive a follow-up: ${survivorsNeedFollowup.size}`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to execute.');
    console.log('sample losers:', JSON.stringify(losers.slice(0, 3)));
    await client.end();
    return;
  }

  // ---- execute ----
  await client.query('BEGIN');
  try {
    const tmp = await client.query(`
      CREATE TEMP TABLE dd (loser_id bigint primary key, survivor_id bigint,
                            ngo_id uuid, donor_id int, loser_followup date)`);
    // insert in batches
    const BATCH = 2000;
    for (let i = 0; i < losers.length; i += BATCH) {
      const slice = losers.slice(i, i + BATCH);
      const values = [];
      const params = [];
      slice.forEach((l, j) => {
        const o = j * 5;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`);
        params.push(l.loser_id, l.survivor_id, l.ngo_id, l.donor_id, l.loser_followup);
      });
      await client.query(
        `INSERT INTO dd (loser_id, survivor_id, ngo_id, donor_id, loser_followup) VALUES ${values.join(',')}`,
        params
      );
    }
    const cnt = await client.query('SELECT count(*)::int AS n FROM dd');
    console.log(`dd rows staged: ${cnt.rows[0].n}`);

    // 1) preserve follow-ups: latest non-NULL loser date onto survivors that have none
    const fu = await client.query(`
      UPDATE fro_assignments surv
      SET next_follow_up = m.best_followup
      FROM (
        SELECT survivor_id, max(loser_followup) AS best_followup
        FROM dd
        WHERE loser_followup IS NOT NULL
        GROUP BY survivor_id
      ) m
      WHERE surv.id = m.survivor_id
        AND surv.next_follow_up IS NULL
      RETURNING surv.id`);
    console.log(`follow-ups copied onto survivors: ${fu.rowCount}`);

    // 2) re-point history
    const r1 = await client.query(`
      UPDATE fro_donor_logs l
      SET assignment_id = m.survivor_id
      FROM dd m
      WHERE l.assignment_id = m.loser_id`);
    console.log(`fro_donor_logs re-pointed: ${r1.rowCount}`);

    const r2 = await client.query(`
      UPDATE fro_scheduled_contacts s
      SET assignment_id = m.survivor_id
      FROM dd m
      WHERE s.assignment_id = m.loser_id`);
    console.log(`fro_scheduled_contacts re-pointed: ${r2.rowCount}`);

    // 3) delete losers (only actual duplicates)
    const del = await client.query(
      'DELETE FROM fro_assignments WHERE id IN (SELECT loser_id FROM dd)');
    console.log(`loser rows deleted: ${del.rowCount}`);

    // 4) verify inside the transaction
    const dup = await client.query(`
      SELECT count(*)::int AS groups
      FROM (SELECT 1 FROM fro_assignments
            WHERE status <> 'reassigned'
            GROUP BY ngo_id, donor_id HAVING count(*) > 1) t`);
    const orph = await client.query(`
      SELECT
        (SELECT count(*) FROM fro_donor_logs
          WHERE assignment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM fro_assignments a WHERE a.id = fro_donor_logs.assignment_id)) AS logs,
        (SELECT count(*) FROM fro_scheduled_contacts
          WHERE assignment_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM fro_assignments a WHERE a.id = fro_scheduled_contacts.assignment_id)) AS sc`);
    const active = await client.query(
      `SELECT count(*)::int AS n FROM fro_assignments WHERE status <> 'reassigned'`);

    console.log('VERIFY dup active groups:', dup.rows[0].groups);
    console.log('VERIFY orphan refs:', JSON.stringify(orph.rows[0]));
    console.log('VERIFY active rows:', active.rows[0].n);

    if (dup.rows[0].groups !== 0) throw new Error('duplicate groups remain');
    if (Number(orph.rows[0].logs) !== 0 || Number(orph.rows[0].sc) !== 0) {
      throw new Error('orphan assignment references remain');
    }

    await client.query('COMMIT');
    console.log('COMMIT OK');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK —', e.message);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
