// Fills signature_signed_at for signatures that predate migration 159.
//
// The migration deliberately leaves that column NULL for already-uploaded
// signatures rather than stamping NOW(), which would invent a signing date. The
// real date still exists in S3 as the object's LastModified, so this reads it
// back and writes the genuine value.
//
// The S3 key is worker_signatures/<workerId>_<epochMillis>.<ext>, so the newest
// object for a worker is the one currently referenced by workers.signature_url.
// The filename timestamp is preferred over LastModified because it is when the
// upload actually happened; LastModified is only the fallback.
//
// Safe to re-run: it only touches rows whose signature_signed_at IS NULL, and it
// only writes when it can match the worker's referenced object exactly.
//
// Requires database access. From a whitelisted host, or after
//   node scripts/open-db-access.mjs
// if the security group rule is missing.

import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { default: db } = await import('../src/config/db.js');
const { ListObjectsV2Command, HeadObjectCommand, S3Client } = await import('@aws-sdk/client-s3');

const region = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const bucket = process.env.S3_BUCKET || 'ucs-crm-head-uploads';
const s3 = new S3Client({ region });

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

// Only the filename part matters; the public URL host differs per environment.
const keyFromUrl = (url) => {
  if (!url) return null;
  const m = /worker_signatures\/([^?#]+)/.exec(String(url));
  return m ? `worker_signatures/${m[1]}` : null;
};

const { rows: pending, error } = await db._pool.query(
  `SELECT id, name, signature_url
     FROM workers
    WHERE signature_url IS NOT NULL
      AND signature_signed_at IS NULL`,
);
if (error) {
  console.error('Could not read workers:', error.message);
  process.exit(1);
}

if (!pending.length) {
  console.log('Nothing to backfill — every stored signature already has a signed date.');
  process.exit(0);
}

console.log(`${pending.length} signature(s) without a signed date.`);
let applied = 0;
let skipped = 0;

for (const w of pending) {
  const key = keyFromUrl(w.signature_url);
  if (!key) {
    console.log(`  skip ${w.name}: URL is not a worker_signatures object`);
    skipped += 1;
    continue;
  }

  // Preferred date: the epoch millis embedded in the object name.
  const fromName = /_(\d{10,})\.[a-z0-9]+$/i.exec(key);
  let signedAt = fromName ? new Date(Number(fromName[1])).toISOString() : null;

  if (!signedAt) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      signedAt = head.LastModified?.toISOString() || null;
    } catch (e) {
      console.log(`  skip ${w.name}: HEAD failed for ${key} (${e.name})`);
      skipped += 1;
      continue;
    }
  }

  if (!signedAt) {
    skipped += 1;
    continue;
  }

  console.log(`  ${w.name}: ${key} -> ${signedAt}`);
  if (DRY) continue;

  const { error: upErr } = await db._pool.query(
    `UPDATE workers SET signature_signed_at = $1 WHERE id = $2 AND signature_signed_at IS NULL`,
    [signedAt, w.id],
  );
  if (upErr) {
    console.error(`  FAILED ${w.name}: ${upErr.message}`);
    continue;
  }
  applied += 1;
}

console.log(
  DRY
    ? `\nDry run. Re-run with --apply to write ${pending.length - skipped} date(s).`
    : `\nApplied ${applied} date(s); skipped ${skipped}.`,
);
process.exit(0);
