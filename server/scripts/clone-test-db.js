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

// ---- 1. Recreate the test schema cleanly ------------------------------
console.log('Dropping/recreating test schema...');
await run('DROP SCHEMA IF EXISTS test CASCADE');
await run('CREATE SCHEMA test');
console.log('test schema ready.');

// ---- 2. Clone each table (structure + data) ---------------------------
const { rows: tables } = await run(
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
);
console.log(`Cloning ${tables.length} tables...`);
const results = [];
for (const t of tables) {
  const name = t.tablename;
  try {
    const dd = await run(`CREATE TABLE test.${name} (LIKE public.${name} INCLUDING ALL)`);
    const data = await run(`INSERT INTO test.${name} SELECT * FROM public.${name}`);
    results.push({ name, status: 'ok', created: dd.command, inserted: data.rowCount });
    console.log(`  [OK] ${name}: ${data.rowCount} rows`);
  } catch (e) {
    results.push({ name, status: 'error', error: String(e) });
    console.log(`  [ERR] ${name}: ${e.message}`);
  }
}
console.log(`\nTables: ${results.filter((r) => r.status === 'ok').length}/${results.length} cloned`);
const errs = results.filter((r) => r.status === 'error');
if (errs.length) {
  console.log('Errors:'); for (const e of errs) console.log('  -', e.name, e.error);
}

// ---- 3. Clone sequences and fix defaults ------------------------------
console.log('\nCloning sequences...');
const { rows: seqs } = await run(
  "SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' ORDER BY sequence_name"
);
for (const s of seqs) {
  const name = s.sequence_name;
  try {
    await run(
      `CREATE SEQUENCE test.${name}
       START WITH (SELECT COALESCE(MAX(1),1) FROM (SELECT 1) x)`
    );
    await run(`ALTER SEQUENCE test.${name} START WITH 1`);
    // set start based on column max where obvious
    const m = name.match(/^(.*)_id_seq$/);
    if (m) {
      const tbl = m[1];
      try {
        const { rows } = await run(`SELECT COALESCE(MAX(id),1) AS mx FROM public.${tbl}`);
        const mx = rows[0].mx;
        await run(`ALTER SEQUENCE test.${name} RESTART WITH ${Number(mx) + 1}`);
      } catch (_) { /* table may not have id column */ }
    }
    console.log(`  [OK] seq ${name}`);
  } catch (e) {
    console.log(`  [ERR] seq ${name}: ${e.message}`);
  }
}

// ---- 4. Re-point serial defaults to test sequences --------------------
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

console.log('\nClone complete.');
