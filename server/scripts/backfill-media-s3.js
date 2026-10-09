// ---------------------------------------------------------------------------
// Backfill: migrate legacy storage URLs (supabase.co host) to the S3-backed
// storage() shim. Downloads each object from the legacy storage host, uploads
// it to S3 (via backend/src/config/db.js), and updates the DB row to the new
// S3 public URL.
//
// Dry-run by default; pass --run to apply changes.
//   node scripts/backfill-media-s3.js [--run]
//
// Targets found by scanning text columns for '%supabase.co%' (Aug 2026):
//   messages.media_url (8), workers.photo_url (68),
//   media_library.file_url (4), fro_donor_logs.payment_screenshot_url (2)
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../src/config/db.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const APPLY = process.argv.includes('--run');

const TARGETS = [
  { table: 'messages', col: 'media_url', bucket: 'whatsapp-media' },
  { table: 'workers', col: 'photo_url', bucket: 'worker-documents' },
  { table: 'media_library', col: 'file_url', bucket: 'media-library' },
  { table: 'fro_donor_logs', col: 'payment_screenshot_url', bucket: 'receipts' },
];

function extractFileName(url) {
  try {
    const u = new URL(url);
    const after = u.pathname.split('/object/public/')[1];
    if (after) return decodeURIComponent(after.replace(/\/$/, ''));
    const base = u.pathname.split('/').pop();
    if (base) return decodeURIComponent(base);
  } catch {}
  return null;
}

async function getPk(table) {
  const { rows } = await db._pool.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
    [table]
  );
  return rows.length ? rows[0].column_name : null;
}

const results = { scanned: 0, migrated: 0, failed: 0, skipped: 0 };

for (const t of TARGETS) {
  const pk = await getPk(t.table);
  if (!pk) {
    console.warn(`[${t.table}] no PK found — skipping table`);
    continue;
  }
  const q = await db._pool.query(
    `SELECT ${pk} AS pk, ${t.col} AS url FROM public.${t.table} WHERE ${t.col} LIKE '%supabase.co%'`
  );
  if (q.rows.length === 0) {
    console.log(`[${t.table}] no supabase.co URLs`);
    continue;
  }
  console.log(`[${t.table}] ${q.rows.length} row(s) found`);

  for (const row of q.rows) {
    results.scanned++;
    const url = String(row.url || '');
    let fileName = extractFileName(url);
    if (!fileName) {
      results.skipped++;
      console.warn(`  skip ${row.pk}: cannot parse file name from ${url}`);
      continue;
    }
    if (fileName.startsWith(`${t.bucket}/`)) fileName = fileName.slice(t.bucket.length + 1);

    if (!APPLY) {
      console.log(`  [dry-run] ${row.pk}: ${url} -> ${fileName}`);
      results.migrated++;
      continue;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || undefined;

      const { error: upErr } = await db.storage.from(t.bucket).upload(fileName, buffer, { contentType, upsert: true });
      if (upErr) throw new Error(upErr.message);

      const { data: urlData } = db.storage.from(t.bucket).getPublicUrl(fileName);
      const newUrl = urlData?.publicUrl;
      if (!newUrl) throw new Error('getPublicUrl returned no URL');

      await db._pool.query(`UPDATE public.${t.table} SET ${t.col} = $1 WHERE ${pk} = $2`, [newUrl, row.pk]);
      results.migrated++;
      console.log(`  ok ${row.pk}: -> ${newUrl}`);
    } catch (e) {
      results.failed++;
      console.error(`  FAIL ${row.pk} (${url}): ${e.message}`);
    }
  }
}

console.log('----------------------------------------');
console.log(`scanned=${results.scanned} migrated=${results.migrated} failed=${results.failed} skipped=${results.skipped}`);
console.log(APPLY ? 'Changes applied (--run).' : 'Dry-run only — rerun with --run to apply.');
