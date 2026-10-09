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

// All non-system app functions in public schema (exclude pg_stat_statements RDS extension funcs)
const { rows: funcs } = await run(`
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname NOT LIKE 'pg_stat_statements%'
  ORDER BY p.proname
`);
console.log(`Cloning ${funcs.length} functions...`);
for (const f of funcs) {
  try {
    // drop any prior test-schema version first (get_functiondef has OR REPLACE,
    // but different arg names can cause duplicates - be safe)
    const args = f.args
      .split(',')
      .map((a) => a.trim().split(/\s+/).pop()) // last token = type
      .filter(Boolean)
      .join(', ');
    await run(`DROP FUNCTION IF EXISTS test.${f.proname}(${args})`);

    let def = f.def;
    // rewrite schema-qualified public. -> test. inside the body
    def = def.replace(/public\./g, 'test.');
    // CREATE FUNCTION is schema-qualified already as test.<name>
    def = def.replace(`CREATE OR REPLACE FUNCTION test.${f.proname}`, `CREATE OR REPLACE FUNCTION test.${f.proname}`);
    await run(def);
    console.log(`  [OK] ${f.proname}`);
  } catch (e) {
    console.log(`  [ERR] ${f.proname}: ${e.message}`);
  }
}
console.log('Functions cloned.');
