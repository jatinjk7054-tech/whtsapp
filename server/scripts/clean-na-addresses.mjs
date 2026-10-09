import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });
import pg from 'pg';

// Matches values that are pure NA-junk: 'na', 'n/a', 'null', '-', 'na, na',
// 'n.a., na' etc. Case-insensitive, allows punctuation/spaces between tokens.
const PURE_JUNK = `'^\\s*(n\\.?a\\.?|n/a|na|nil|null|none|not available|-+|\u2014)\\s*(,\\s*(n\\.?a\\.?|n/a|na|nil|null|none|not available|-+|\u2014)\\s*)*$'`;

const TRIM_TAIL = `\\s*,\\s*(n\\.?a\\.?|n/a|nil|null|none|not available)\\s*\\.?\\s*$`;
const TRIM_HEAD = `^\\s*(n\\.?a\\.?|n/a|nil|null|none|not available)\\s*,\\s*`;

(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const targets = [
    ['receipts', 'address'],
    ['receipts', 'address_2'],
    ['donor_profiles', 'address_1'],
    ['donor_profiles', 'address_2'],
  ];

  console.log('=== Before ===');
  for (const [t, col] of targets) {
    const r = await c.query(`SELECT count(*)::int n FROM public.${t} WHERE ${col} IS NOT NULL AND ${col} ~ ${PURE_JUNK}`);
    const t2 = await c.query(`SELECT count(*)::int n FROM public.${t} WHERE ${col} IS NOT NULL AND (${col} ~* '${TRIM_TAIL}' OR ${col} ~ '${TRIM_HEAD}')`);
    console.log(`${t}.${col}: pure-junk=${r.rows[0].n}, partial-junk=${t2.rows[0].n}`);
  }

  let total = 0;
  for (const [t, col] of targets) {
    // 1) strip trailing ", NA" fragments inside longer addresses
    let r = await c.query(`UPDATE public.${t} SET ${col} = regexp_replace(${col}, '${TRIM_TAIL}', '', 'i') WHERE ${col} ~* '${TRIM_TAIL}'`);
    total += r.rowCount;
    // 2) strip leading "NA, " fragments
    r = await c.query(`UPDATE public.${t} SET ${col} = regexp_replace(${col}, '${TRIM_HEAD}', '', 'i') WHERE ${col} ~ '${TRIM_HEAD}'`);
    total += r.rowCount;
    // 3) null out pure-junk values (case-insensitive)
    r = await c.query(`UPDATE public.${t} SET ${col} = NULL WHERE ${col} IS NOT NULL AND (${col} ~* ${PURE_JUNK} OR btrim(${col}) = '')`);
    total += r.rowCount;
    console.log(`cleaned ${t}.${col}`);
  }
  console.log(`\nTotal rows cleaned: ${total}`);

  console.log('\n=== After (remaining junk) ===');
  for (const [t, col] of targets) {
    const r = await c.query(`SELECT count(*)::int n FROM public.${t} WHERE ${col} IS NOT NULL AND ${col} ~ ${PURE_JUNK}`);
    console.log(`${t}.${col}: ${r.rows[0].n}`);
  }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
