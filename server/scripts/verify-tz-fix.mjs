import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import db from '../src/config/db.js';

(async () => {
  const r = await db._pool.query("SELECT current_setting('timezone') AS tz");
  console.log('session timezone:', r.rows[0].tz);
  const d = await db._pool.query("SELECT receipt_date::date AS ist_day FROM receipts WHERE id=1889960");
  console.log('mann #583 ::date now resolves to:', d.rows[0].ist_day);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
