import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

import pg from 'pg';

const MONTH_START = process.argv[2] || new Date().toISOString().slice(0, 7) + '-01';

const EXCLUDE = ['suspense', 'na', 'n/a', 'bank transfer', 'pay u money', 'payumoney',
  'cheque', 'courier', 'office visit', 'ashram visit', 'library', 'rent',
  'freecharge', 'savak data', 'cashlar', 'priyank shah', 'priyank sir'];

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
  await c.connect();
  console.log('Connected. Fixing receipts from', MONTH_START, 'onwards\n');

  // ── STEP 0: before-state ────────────────────────────────────────────────
  const before = await c.query(
    `SELECT count(*) n, coalesce(sum(amount),0)::numeric total FROM receipts
     WHERE receipt_date >= $1 AND agent_name IS NOT NULL AND btrim(agent_name) <> ''`, [MONTH_START]);
  console.log(`Receipts in scope: ${before.rows[0].n} | total ₹${before.rows[0].total}`);

  // ── STEP 1: fix dirty names INSIDE workers table (e.g. "Chhaya  Kumari") ─
  const dirtyWorkers = await c.query(
    `SELECT id, name, trim(regexp_replace(name, '\\s+', ' ', 'g')) clean
     FROM workers
     WHERE name IS DISTINCT FROM trim(regexp_replace(name, '\\s+', ' ', 'g'))`);
  console.log(`\nSTEP 1 — workers.name cleanup (${dirtyWorkers.rowCount} fixed):`);
  for (const w of dirtyWorkers.rows) {
    await c.query('UPDATE workers SET name=$1 WHERE id=$2', [w.clean, w.id]);
    console.log(`  "${w.name}" -> "${w.clean}"`);
  }

  // ── STEP 2: build temp tables ────────────────────────────────────────────
  await c.query(`CREATE TEMP TABLE fro_w AS
    SELECT id, name, lower(trim(name)) lname
    FROM workers WHERE upper(trim(department)) = 'FRO'`);

  const exclList = EXCLUDE.map(e => `'${e}'`).join(',');

  await c.query(`CREATE TEMP TABLE aug_names AS
    SELECT DISTINCT trim(regexp_replace(agent_name, '\\s+', ' ', 'g')) aname
    FROM receipts
    WHERE receipt_date >= $1
      AND agent_name IS NOT NULL AND btrim(agent_name) <> ''
      AND lower(btrim(agent_name)) NOT IN (${exclList})`, [MONTH_START]);

  // ── STEP 3: resolve each distinct name -> canonical worker ──────────────
  // Tier 1: exact (case-insensitive)          Tier 2: parens-stripped exact
  // Tier 3: token-subset UNIQUE (either direction)
  // Tier 4: levenshtein<=2 unique (if ext available)
  let hasFuzzy = true;
  try { await c.query('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch'); }
  catch { hasFuzzy = false; console.log('(fuzzystrmatch not available — skipping levenshtein tier)'); }

  const tier4Sql = hasFuzzy ? `
      UNION ALL
      SELECT w.name, 4 FROM fro_w w
        WHERE length(w.lname) >= 5
          AND levenshtein(lower(n.aname), w.lname) <= 2
          AND (SELECT count(*) FROM fro_w w2
               WHERE length(w2.lname) >= 5 AND levenshtein(lower(n.aname), w2.lname) <= 2) = 1` : '';

  await c.query(`CREATE TEMP TABLE name_map AS
    SELECT n.aname, m.target, m.tier
    FROM aug_names n
    JOIN LATERAL (
      SELECT w.name target, 1 tier FROM fro_w w WHERE lower(n.aname) = w.lname
      UNION ALL
      SELECT w.name, 2 FROM fro_w w
        WHERE lower(regexp_replace(n.aname, '\\(.*?\\)', ' ', 'g')) = w.lname
      UNION ALL
      SELECT w.name, 3 FROM fro_w w
        WHERE string_to_array(w.lname, ' ') <> ARRAY[]::text[]
          AND COALESCE((SELECT array_agg(x) FROM unnest(string_to_array(regexp_replace(lower(regexp_replace(n.aname, '\\(.*?\\)', ' ', 'g')), '[^a-z ]', '', 'g'), ' ')) x WHERE x <> ''), ARRAY[]::text[]) <> ARRAY[]::text[]
          AND (string_to_array(w.lname, ' ') <@ COALESCE((SELECT array_agg(x) FROM unnest(string_to_array(regexp_replace(lower(regexp_replace(n.aname, '\\(.*?\\)', ' ', 'g')), '[^a-z ]', '', 'g'), ' ')) x WHERE x <> ''), ARRAY[]::text[])
               OR COALESCE((SELECT array_agg(x) FROM unnest(string_to_array(regexp_replace(lower(regexp_replace(n.aname, '\\(.*?\\)', ' ', 'g')), '[^a-z ]', '', 'g'), ' ')) x WHERE x <> ''), ARRAY[]::text[]) <@ string_to_array(w.lname, ' '))
          AND (SELECT count(*) FROM fro_w w2
               WHERE string_to_array(w2.lname, ' ') <> ARRAY[]::text[]
                 AND (string_to_array(w2.lname, ' ') <@ COALESCE((SELECT array_agg(y) FROM unnest(string_to_array(regexp_replace(lower(regexp_replace(n.aname, '\\(.*?\\)', ' ', 'g')), '[^a-z ]', '', 'g'), ' ')) y WHERE y <> ''), ARRAY[]::text[])
                      OR COALESCE((SELECT array_agg(y) FROM unnest(string_to_array(regexp_replace(lower(regexp_replace(n.aname, '\\(.*?\\)', ' ', 'g')), '[^a-z ]', '', 'g'), ' ')) y WHERE y <> ''), ARRAY[]::text[]) <@ string_to_array(w2.lname, ' '))) = 1${tier4Sql}
      ORDER BY tier LIMIT 1
    ) m ON true`);

  // ── STEP 4: apply to receipts (this month only) ─────────────────────────
  let totalUpdated = 0;
  for (const tier of [1, 2, 3, 4]) {
    const r = await c.query(
      `UPDATE receipts r SET agent_name = m.target
       FROM name_map m
       WHERE r.receipt_date >= $1
         AND trim(regexp_replace(r.agent_name, '\\s+', ' ', 'g')) = m.aname
         AND m.tier = $2
         AND r.agent_name IS DISTINCT FROM m.target`, [MONTH_START, tier]);
    totalUpdated += r.rowCount;
    console.log(`Tier ${tier}: ${r.rowCount} receipts updated`);
  }

  // ── STEP 5: detailed change report (who was fixed -> to what) ───────────
  console.log('\n===== NAME FIX REPORT =====');
  const changes = await c.query(
    `SELECT nm.aname old_name, nm.target new_name, nm.tier, count(r.id) receipts,
            coalesce(sum(r.amount),0)::numeric amt
     FROM name_map nm
     LEFT JOIN receipts r ON r.receipt_date >= $1
       AND trim(regexp_replace(r.agent_name, '\\s+', ' ', 'g')) = nm.aname
     WHERE lower(nm.aname) <> lower(nm.target)
     GROUP BY nm.aname, nm.target, nm.tier
     HAVING count(r.id) > 0 OR true
     ORDER BY receipts DESC`, [MONTH_START]);
  for (const row of changes.rows) {
    console.log(`  "${row.old_name}" -> "${row.new_name}"  [tier${row.tier}]  (${row.receipts} receipts, ₹${row.amt})`);
  }

  const stillUn = await c.query(
    `SELECT n.aname FROM aug_names n
     WHERE NOT EXISTS (SELECT 1 FROM name_map m WHERE m.aname = n.aname)
     ORDER BY n.aname LIMIT 40`);
  console.log(`\nStill unmatched distinct names (sample):`);
  for (const u of stillUn.rows) console.log(`  - "${u.aname}"`);

  // ── STEP 6: after-state + Chhaya verification ───────────────────────────
  const after = await c.query(
    `SELECT count(DISTINCT agent_name) names FROM receipts
     WHERE receipt_date >= $1 AND agent_name IS NOT NULL AND btrim(agent_name) <> ''
       AND lower(btrim(agent_name)) NOT IN (${exclList})`, [MONTH_START]);
  console.log(`\nDistinct agent_names this month: before=${(await c.query('SELECT count(*) n FROM aug_names')).rows[0].n}(pre-fix) -> now ${after.rows[0].names}`);

  const chhaya = await c.query(
    `SELECT agent_name, count(*) n, sum(amount)::numeric total FROM receipts
     WHERE receipt_date >= $1 AND lower(agent_name) LIKE '%chhaya%kumari%'
     GROUP BY agent_name`, [MONTH_START]);
  console.log('\nChhaya Kumari receipts this month:');
  for (const r of chhaya.rows) console.log(`  "${r.agent_name}": ${r.n} receipts, ₹${r.total}`);
  const wk = await c.query(`SELECT name FROM workers WHERE lower(name) LIKE '%chhaya%' AND upper(department)='FRO'`);
  console.log(`Worker record now: "${wk.rows.map(r => r.name).join(', ')}"`);

  await c.end();
  console.log('\nDONE.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
