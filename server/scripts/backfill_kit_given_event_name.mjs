import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

import pg from 'pg';

const IS_MISSING = `(details IS NULL
  OR details->>'event_name' IS NULL
  OR btrim(details->>'event_name') = ''
  OR lower(details->>'event_name') = 'null')`;

(async () => {
  const c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await c.connect();
  console.log('Connected.\n');

  const missing = await c.query(
    `SELECT count(*)::int n FROM beneficiary_audit_logs
     WHERE action = 'KIT_GIVEN' AND ${IS_MISSING}`);
  console.log(`KIT_GIVEN rows missing an event name: ${missing.rows[0].n}\n`);

  if (missing.rows[0].n > 0) {
    const applied = await c.query(
      `UPDATE beneficiary_audit_logs
       SET details = (coalesce(details, '{}')::jsonb || '{"event_name":"Demo Event"}'::jsonb)::jsonb
       WHERE action = 'KIT_GIVEN' AND ${IS_MISSING}`);
    console.log(`Backfilled ${applied.rowCount} row(s) with event_name = 'Demo Event'.`);
  } else {
    console.log('Nothing to backfill.');
  }

  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});