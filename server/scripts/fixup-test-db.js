const API = 'https://api.beingsevak.org/api/db/query';

async function run(sql) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${txt}`);
  return JSON.parse(txt);
}

// ---- 1. Retry failed tables -------------------------------------------
const retryTables = ['event_head_expenses', 'razorpay_accounts', 'worker_family'];
for (const name of retryTables) {
  try {
    await run(`DROP TABLE IF EXISTS test.${name}`);
    await run(`CREATE TABLE test.${name} (LIKE public.${name} INCLUDING ALL)`);
    const data = await run(`INSERT INTO test.${name} SELECT * FROM public.${name}`);
    console.log(`  [OK] ${name}: ${data.rowCount} rows`);
  } catch (e) {
    console.log(`  [ERR] ${name}: ${e.message}`);
  }
}

// ---- 2. Create sequences properly -------------------------------------
const { rows: seqs } = await run(
  "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' ORDER BY sequence_name"
);
console.log(`\nCreating ${seqs.length} sequences...`);
for (const s of seqs) {
  const name = s.sequence_name;
  try {
    await run(`CREATE SEQUENCE test.${name}`);
    const m = name.match(/^(.*)_id_seq$/);
    if (m) {
      const tbl = m[1];
      try {
        const { rows } = await run(`SELECT COALESCE(MAX(id),1) AS mx FROM public.${tbl}`);
        const mx = rows[0].mx;
        await run(`ALTER SEQUENCE test.${name} RESTART WITH ${Number(mx) + 1}`);
        console.log(`  [OK] seq ${name} (restart ${Number(mx) + 1})`);
      } catch (_) {
        await run(`ALTER SEQUENCE test.${name} RESTART WITH 1`);
        console.log(`  [OK] seq ${name} (default)`);
      }
    } else {
      await run(`ALTER SEQUENCE test.${name} RESTART WITH 1`);
      console.log(`  [OK] seq ${name} (no table)`);
    }
  } catch (e) {
    console.log(`  [ERR] seq ${name}: ${e.message}`);
  }
}

// ---- 3. Re-point serial defaults to test sequences --------------------
console.log('\nRe-pointing serial defaults...');
const { rows: defaults } = await run(`
  SELECT c.relname AS table_name, a.attname AS column_name,
         pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
  FROM pg_attrdef ad
  JOIN pg_class c ON c.oid = ad.adrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
  WHERE n.nspname = 'public'
    AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%nextval%'
`);
for (const d of defaults) {
  const m = d.default_expr.match(/nextval\('([^']+)'/);
  if (!m) continue;
  const seqName = m[1].split('.').pop();
  try {
    await run(
      `ALTER TABLE test.${d.table_name} ALTER COLUMN ${d.column_name}
       SET DEFAULT nextval('test.${seqName}'::regclass)`
    );
    console.log(`  [OK] ${d.table_name}.${d.column_name} -> test.${seqName}`);
  } catch (e) {
    console.log(`  [ERR] default ${d.table_name}.${d.column_name}: ${e.message}`);
  }
}

console.log('\nFix-up complete.');
