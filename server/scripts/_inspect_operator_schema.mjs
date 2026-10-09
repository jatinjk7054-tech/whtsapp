import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

import pg from 'pg';

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const cols = await c.query(`SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_name IN ('workers','operator_assignments','operator_events','auth_sessions','login_sessions')
  ORDER BY table_name, ordinal_position`);
console.table(cols.rows);

const rows = await c.query(`SELECT count(*)::int n, min(id::text) mn, max(id::text) mx FROM workers`);
console.table(rows.rows);

const asg = await c.query(`SELECT count(*)::int n FROM operator_assignments`);
console.log(`operator_assignments rows: ${asg.rows[0].n}`);
const ev = await c.query(`SELECT id, title, event_date FROM operator_events ORDER BY id LIMIT 10`);
console.table(ev.rows);

await c.end();