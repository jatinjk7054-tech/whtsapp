import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const u = new URL(process.env.DATABASE_URL);
u.hostname = 'localhost';
u.port = '5434';
const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await c.connect();

const exists = await c.query(
  `SELECT count(*)::int AS n FROM information_schema.tables
   WHERE table_schema='public' AND table_name='notification_log'`
);
if (!exists.rows[0].n) {
  console.log('notification_log does NOT exist');
} else {
  const t = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='notification_log'
     ORDER BY ordinal_position`
  );
  console.log('notification_log columns:');
  console.table(t.rows);

  const n = await c.query('SELECT count(*)::int AS n FROM notification_log');
  console.log('rows:', n.rows[0].n);

  const s = await c.query('SELECT sample.* FROM notification_log sample LIMIT 3');
  console.log('sample:', s.rows);
}

await c.end();
