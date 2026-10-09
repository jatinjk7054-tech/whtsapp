// ---------------------------------------------------------------------------
// Sevak Library migration: Supabase -> UCS CRM main Postgres + AWS S3.
//
//   1. Creates the sevak tables in the main DB (scripts/sevak-library-schema.sql).
//   2. Pulls all rows (applications, coupons, mail_log) from the Supabase REST
//      API and inserts them into the main DB, preserving ids.
//   3. Copies every SevakMedia storage object referenced by an application
//      (plus unreferenced files sitting under an application's ref) into S3 via
//      the db.storage shim, keeping the same object path so the backend's
//      /photo-url presign can address them later.
//
// Dry-run by default; pass --run to apply changes:
//   node scripts/migrate-sevak-library.mjs [--run]
//
// Requires backend/.env: DATABASE_URL, SEVAK_SUPABASE_URL,
// SEVAK_SUPABASE_SERVICE_ROLE_KEY (+ S3 creds for the storage shim).
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../src/config/db.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const APPLY = process.argv.includes('--run');
const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sevak-library-schema.sql');
const BUCKET = 'SevakMedia';
const S3_FOLDER = 'sevak-library';

const SUPABASE_URL = process.env.SEVAK_SUPABASE_URL;
const SERVICE_KEY = process.env.SEVAK_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SEVAK_SUPABASE_URL / SEVAK_SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

async function fetchAll(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const qs = new URLSearchParams({ select: '*', order: 'id.asc', offset: String(offset), limit: '1000' });
    const res = await fetch(`${REST}/${table}?${qs}`, { headers: H });
    if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function listObjects(prefix) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error(`list ${prefix}: ${res.status}`);
  return res.json();
}

async function uploadToS3(name) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${name}`, { headers: H });
  if (!res.ok) throw new Error(`download ${name}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const { error } = await db.storage.from(S3_FOLDER).upload(name, buffer, { contentType, upsert: true });
  if (error) throw new Error(error.message);
}

async function applySchema() {
  const sql = fs.readFileSync(SCHEMA, 'utf8');
  const statements = sql
    .replace(/^--[^\n]*\n/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db._pool.query(stmt);
  }
  console.log('Schema applied.');
}

async function insertRows(table, rows) {
  if (rows.length === 0) return { inserted: 0 };
  const cols = Object.keys(rows[0]).filter(c => c !== 'id');
  const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ');
  const quoted = cols.map(c => `"${c}"`).join(', ');
  const q = `INSERT INTO public.${table} (id, ${quoted}) VALUES ($1, ${placeholders})
             ON CONFLICT (id) DO NOTHING RETURNING id`;
  let inserted = 0;
  for (const r of rows) {
    const vals = cols.map(c => (r[c] == null ? null : r[c]));
    const res = await db._pool.query(q, [r.id, ...vals]);
    if (res.rows.length) inserted++;
  }
  await db._pool.query(`SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), COALESCE(max(id), 1)) FROM public.${table}`);
  return { inserted };
}

const results = { applications: 0, coupons: 0, mail_log: 0, docs: 0, docs_failed: 0, docs_skipped: 0 };

async function migrateDocs() {
  const apps = await fetchAll('applications');
  const byRef = new Map();
  for (const a of apps) if (a.ref) byRef.set(a.ref, a);

  const referenced = new Set();
  for (const a of apps) {
    if (a.passport_photo) referenced.add(a.passport_photo);
    if (a.identity_photo) referenced.add(a.identity_photo);
  }

  const topLevel = await listObjects('');
  const seen = new Set();

  for (const tl of topLevel) {
    const name = String(tl.name || '');
    if (/^(js-test|rls-check)/.test(name)) continue; // junk test artifacts
    const prefix = name.endsWith('/') ? name : name + '/';
    let files;
    try {
      files = await listObjects(prefix);
    } catch (e) {
      console.error(`  FAIL list ${prefix}: ${e.message}`);
      results.docs_failed++;
      continue;
    }
    for (const f of files) {
      const rel = f.name;
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const ref = rel.split('/')[0];
      if (!byRef.has(ref)) {
        results.docs_skipped++;
        console.log(`  skip unreferenced ${rel}`);
        continue;
      }
      try {
        await uploadToS3(rel);
        results.docs++;
        console.log(`  ok ${rel}`);
      } catch (e) {
        results.docs_failed++;
        console.error(`  FAIL ${rel}: ${e.message}`);
      }
    }
  }

  for (const p of referenced) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      await uploadToS3(p);
      results.docs++;
      console.log(`  ok(referenced) ${p}`);
    } catch (e) {
      results.docs_failed++;
      console.error(`  FAIL ${p}: ${e.message}`);
    }
  }
}

async function main() {
  console.log(APPLY ? 'APPLYING changes (--run).' : 'DRY-RUN — rerun with --run to apply.');

  if (APPLY) await applySchema();

  for (const t of ['applications', 'coupons', 'mail_log']) {
    const rows = await fetchAll(t);
    console.log(`[${t}] source rows: ${rows.length}`);
    if (APPLY) {
      const { inserted } = await insertRows(t, rows);
      results[t] = inserted;
      console.log(`[${t}] inserted ${inserted} (${rows.length - inserted} already present)`);
    } else {
      results[t] = rows.length;
    }
  }

  if (APPLY) {
    await migrateDocs();
  } else {
    console.log(`[docs] dry-run only; ${BUCKET} download/upload skipped.`);
  }

  console.log('----------------------------------------');
  console.log(`applications=${results.applications} coupons=${results.coupons} mail_log=${results.mail_log} docs=${results.docs} docs_failed=${results.docs_failed} docs_skipped=${results.docs_skipped}`);
  console.log(APPLY ? 'Migration applied.' : 'Dry-run only — rerun with --run to apply.');
}

main().catch((e) => { console.error('Migration stopped:', e.message); process.exit(1); });