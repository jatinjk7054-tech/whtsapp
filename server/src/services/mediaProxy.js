import { GetObjectCommand } from '@aws-sdk/client-s3';
import db from '../config/db.js';

// ---------------------------------------------------------------------------
// Stored-file proxy.
//
// Image columns hold full URLs, and they come from two very different places:
//
//   Supabase public storage  → https://<project>.supabase.co/storage/v1/object/public/...
//   S3 (app buckets)         → https://<bucket>.s3.<region>.amazonaws.com/<key>
//
// The Supabase ones load straight into an <img>. The S3 ones do not: those
// buckets are private, so a browser request comes back 403 and the cell shows a
// dead image. This service reads them with the app's own S3 credentials — the
// same ones db.storage.raw() hands the object API — so the viewer can show what
// is actually in the row without anyone opening a bucket to the internet.
// ---------------------------------------------------------------------------

// https://bucket.s3.ap-south-1.amazonaws.com/key
const VIRTUAL_HOST = /^https?:\/\/([^./]+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com\/(.+)$/i;
// https://s3.ap-south-1.amazonaws.com/bucket/key  and  https://s3-eu-west-1.amazonaws.com/bucket/key
const PATH_STYLE = /^https?:\/\/s3[.-]([a-z0-9-]+)\.amazonaws\.com\/([^/]+)\/(.+)$/i;

// Only image and document types a cell can sensibly preview. Anything else is
// left alone rather than streamed.
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

const typeFor = (key) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(key).split('?')[0]);
  return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream';
};

// The bucket and key a stored URL points at, or null when it is not S3 (a
// Supabase public URL, say) and therefore needs no proxy.
export function parseS3Url(url) {
  const v = String(url || '').trim();
  let m = VIRTUAL_HOST.exec(v);
  if (m) return { bucket: decodeURIComponent(m[1]), key: decodeURIComponent(m[3]) };
  m = PATH_STYLE.exec(v);
  if (m) return { bucket: decodeURIComponent(m[2]), key: decodeURIComponent(m[3]) };
  return null;
}

// Which account can read a given bucket. The registry holds one configured
// bucket per account, but a bucket URL can name any bucket that account can
// reach, so this is a preference order rather than a lookup: try the accounts
// whose own bucket matches first, then the rest.
function candidateAccounts(bucket) {
  const accounts = db.storage.accounts().filter((a) => a.configured);
  const exact = accounts.filter((a) => a.bucket === bucket);
  const rest = accounts.filter((a) => a.bucket !== bucket);
  return exact.concat(rest).map((a) => a.name);
}

// Open a stored object for streaming. Tries each configured account in turn and
// returns the first that can read it; null when none can (an S3 URL for a bucket
// this deployment has no keys for, or not an S3 URL at all).
export async function openStoredObject(url) {
  const ref = parseS3Url(url);
  if (!ref) return null;

  for (const account of candidateAccounts(ref.bucket)) {
    const handle = db.storage.raw(account);
    if (!handle) continue;
    try {
      const r = await handle.client.send(new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key }));
      return {
        account,
        bucket: ref.bucket,
        key: ref.key,
        body: r.Body,
        contentType: r.ContentType || typeFor(ref.key),
        contentLength: r.ContentLength ?? null,
        lastModified: r.LastModified || null,
      };
    } catch (err) {
      // Wrong account for this bucket (AccessDenied/NoSuchBucket) — try the next.
    }
  }
  return null;
}
