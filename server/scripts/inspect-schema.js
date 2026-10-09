const API = 'https://api.beingsevak.org/api/db/query';

async function run(sql) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status}: ${t}`);
  }
  return r.json();
}

// Sequences and their owning table/column via default expressions
const seqs = await run(`
  SELECT s.sequence_name,
         n.nspname AS seq_schema,
         a.attrelid::regclass::text AS table_name,
         a.attname AS column_name
  FROM information_schema.sequences s
  JOIN pg_namespace n ON n.nspname = s.sequence_schema
  LEFT JOIN pg_depend d
    ON d.objid = ('"' || s.sequence_schema || '"."' || s.sequence_name || '"')::regclass
   AND d.classid = 'pg_class'::regclass
   AND d.deptype = 'a'
  LEFT JOIN pg_class c ON c.oid = d.refobjid AND c.relkind = 'S'
  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
  WHERE s.sequence_schema = 'public'
  ORDER BY s.sequence_name
`);
console.log('=== SEQUENCES (' + seqs.rows.length + ') ===');
for (const s of seqs.rows) console.log(JSON.stringify(s));

// Sequences actually referenced by column defaults (serial columns)
const defaults = await run(`
  SELECT c.relname AS table_name,
         a.attname AS column_name,
         pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
  FROM pg_attrdef ad
  JOIN pg_class c ON c.oid = ad.adrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
  WHERE n.nspname = 'public'
    AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%nextval%'
  ORDER BY c.relname, a.attnum
`);
console.log('=== SERIAL DEFAULTS (' + defaults.rows.length + ') ===');
for (const s of defaults.rows) console.log(JSON.stringify(s));

// Identity columns
const identity = await run(`
  SELECT c.relname AS table_name, a.attname AS column_name, a.attidentity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public' AND a.attidentity <> ''
  ORDER BY c.relname
`);
console.log('=== IDENTITY COLUMNS (' + identity.rows.length + ') ===');
for (const s of identity.rows) console.log(JSON.stringify(s));

// Functions
const funcs = await run(`
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
  ORDER BY p.proname
`);
console.log('=== FUNCTIONS (' + funcs.rows.length + ') ===');
for (const s of funcs.rows) console.log(JSON.stringify({ name: s.proname, args: s.args }));

// Views
const views = await run(`
  SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname
`);
console.log('=== VIEWS ===');
console.log(JSON.stringify(views.rows));
