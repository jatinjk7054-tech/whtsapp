import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const APPLY = process.argv.includes('--apply');

const run = async () => {
  await client.connect();
  const r = await client.query(
    `SELECT d.id, d.name,
            (SELECT count(*) FROM receipts rc WHERE rc.donor_id = d.id) AS receipts,
            (SELECT count(*) FROM fro_donor_logs l WHERE l.donor_id = d.id) AS logs,
            (SELECT count(*) FROM fro_assignments a WHERE a.donor_id = d.id) AS assigns
     FROM donor_profiles d
     WHERE d.mobile_number LIKE 'NOCELL-%' AND d.created_at >= '2026-08-17'
     ORDER BY d.id`
  );
  const orphans = r.rows.filter((x) => x.receipts === 0 && x.logs === 0 && x.assigns === 0);
  console.log('All NOCELL profiles:', r.rows.length);
  console.log('Fully orphaned (no receipts/logs/assignments):', orphans.length);
  for (const row of orphans) console.log(`#${row.id} | ${row.name}`);
  console.log('Non-orphan NOCELL profiles:');
  for (const row of r.rows.filter((x) => x.receipts > 0 || x.logs > 0 || x.assigns > 0)) {
    console.log(`#${row.id} | ${row.name} | rcpt=${row.receipts} logs=${row.logs} assigns=${row.assigns}`);
  }

  if (APPLY && orphans.length) {
    const ids = orphans.map((x) => x.id);
    const del = await client.query(`DELETE FROM donor_profiles WHERE id = ANY($1::int[])`, [ids]);
    console.log(`\nDELETED ${del.rowCount} orphan donor profiles`);
  }
  await client.end();
};
run().catch((e) => { console.error(e); process.exit(1); });