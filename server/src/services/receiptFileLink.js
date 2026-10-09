// Publicly reachable, non-guessable link to a receipt PDF that lives in a
// private S3 bucket.
//
// Why this exists: a WhatsApp template with a HEADER document must be given a
// link, and Meta downloads it itself. The receipts bucket
// (ucs-crm-uploads-mumbai) stopped serving anonymous reads, and the IAM user the
// backend runs as cannot grant public access (no s3:PutBucketPolicy, no
// s3:PutObjectAcl -- verified, not assumed). Making the bucket public therefore
// needs a third party.
//
// So the backend stops being the thing that must be reachable and becomes the
// thing that IS reachable: Meta fetches a signed URL from this service, which
// streams the PDF out of the private bucket using credentials it already holds.
// Donors' PAN numbers, addresses and amounts stay private, because a receipt is
// now only readable by someone holding a link that expires.
//
// The token is a payload plus an HMAC over that payload. It is deliberately not
// a JWT: it is signed with a purpose-derived subkey so it can never be confused
// with, or replayed as, a session token.

import crypto from 'node:crypto';

// Meta fetches the header document asynchronously, so the link has to outlive
// the send request by a comfortable margin. An hour is far longer than the
// observed gap (delivery frames arrived within ~30s) while still making a leaked
// link useless almost immediately.
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const MAX_TTL_MS = 6 * 60 * 60 * 1000;

// Object keys this service will ever read. The token is HMAC-signed so a
// traversal cannot be forged, but the shape is still validated: this endpoint
// is unauthenticated, and the blast radius of a validation mistake here is the
// whole bucket.
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/;
const ALLOWED_ACCOUNTS = new Set(['head', 'upstream', 'legacy']);

// The character class above cannot exclude `..` on its own: a key like
// `receipts/../../root` is made entirely of allowed characters. S3 resolves
// `..` segments, so a key has to be checked segment-wise or a signed link can
// be pointed outside the receipts prefix.
function isSafeKey(key) {
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) return false;
  if (key.includes('..') || key.includes('//')) return false;
  return key.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

// Exported so services that sign an object from a database column rather than
// from a token can apply the same guard. S3 resolves `..` inside a key, so a
// value that merely *starts* with an allowed prefix is not necessarily inside it.
export { isSafeKey };

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function secretBytes() {
  const base = process.env.RECEIPT_LINK_SECRET || process.env.JWT_SECRET || '';
  if (!base) throw new Error('RECEIPT_LINK_SECRET or JWT_SECRET must be set to sign receipt links');
  // Domain separation: a token minted here is only ever valid for this purpose,
  // and a JWT signed with the same secret will never validate as a receipt link.
  return crypto.createHmac('sha256', base).update('ucs:whatsapp:receipt-file:v1').digest();
}

function sign(payloadJson) {
  return b64url(crypto.createHmac('sha256', secretBytes()).update(payloadJson).digest());
}

export function ttlMs(override) {
  const n = Number(override);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.min(n, MAX_TTL_MS);
}

/**
 * Mints a token for one object in one account.
 * `account` must be the account the object was actually written to, so the
 * serving side never has to guess which bucket holds it.
 */
export function signReceiptFile({ account, key, ttlMs: ttl } = {}) {
  if (!ALLOWED_ACCOUNTS.has(account)) throw new Error(`signReceiptFile: unknown storage account "${account}"`);
  if (!isSafeKey(key)) throw new Error('signReceiptFile: unsafe object key');
  const expiresAt = Date.now() + ttlMs(ttl);
  const payloadJson = JSON.stringify({ a: account, k: key, e: expiresAt });
  return `${b64url(payloadJson)}.${sign(payloadJson)}`;
}

/**
 * Returns `{ account, key, expiresAt }`, or throws with a reason safe to log.
 * Throwing rather than returning null keeps every failure branch at the call
 * site explicit -- this is the authentication check for an unauthenticated
 * endpoint, and it must never have a fall-through path.
 */
export function verifyReceiptFile(token) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('missing token');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('malformed token');

  let payloadJson;
  try {
    payloadJson = Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    throw new Error('malformed token');
  }

  const expected = Buffer.from(sign(payloadJson), 'utf8');
  const actual = Buffer.from(parts[1], 'utf8');
  // Constant-time: a length check followed by a byte compare is enough because
  // the signature is fixed-width hex-ish base64url, and timingSafeEqual refuses
  // mismatched lengths anyway.
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('invalid signature');
  }

  let payload;
  try { payload = JSON.parse(payloadJson); } catch { throw new Error('malformed token payload'); }

  if (!ALLOWED_ACCOUNTS.has(payload?.a)) throw new Error('unknown storage account');
  if (!isSafeKey(payload?.k)) throw new Error('unsafe object key');
  if (!Number.isFinite(payload?.e)) throw new Error('missing expiry');

  if (payload.e <= Date.now()) throw new Error('link expired');

  return { account: payload.a, key: payload.k, expiresAt: payload.e };
}

/**
 * Works out which configured account owns a stored S3 object URL, and why not
 * when no account does. Split out of describeStoredObjectUrl so the caller can be
 * told the reason; that function's contract (null on failure) is preserved for
 * everything that only needs to know whether the URL is usable.
 */
function classifyStoredObjectUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { account: null, key: null, reason: 'unparseable' }; }
  const bucket = parsed.host.split('.')[0];
  if (!bucket) return { account: null, key: null, reason: 'unparseable' };

  const configured = [
    ['head', process.env.HEAD_S3_BUCKET],
    ['upstream', process.env.UPSTREAM_S3_BUCKET],
    ['legacy', process.env.S3_BUCKET],
  ];
  const account = configured.find(([, name]) => name && String(name) === bucket)?.[0];
  if (!account) return { account: null, key: null, reason: 'unknown-bucket', bucket };

  // The S3 key is the whole path: s3Key() prefixes the bucket name, so
  // `receipts/receipts/83574.pdf` in a URL is the complete key, not a relative
  // one. Handing back only the tail would silently read the wrong object.
  const key = parsed.pathname.replace(/^\/+/, '');
  if (!isSafeKey(key)) return { account, key: null, reason: 'unsafe-key', bucket };
  return { account, key, reason: null };
}

/**
 * Maps a stored S3 object URL back to the configured account that owns it, and
 * returns the object key, or null when that cannot be done.
 *
 * Needed for receipts uploaded before this service existed, where only the full
 * bucket URL was persisted and the storage account was never recorded. Deriving
 * the bucket from the hostname and matching it against configuration is exact:
 * a URL from a bucket this deployment does not manage yields null rather than a
 * guess. Use explainStoredObjectUrl when the caller has to report the reason.
 */
export function describeStoredObjectUrl(url) {
  const { account, key, reason } = classifyStoredObjectUrl(url);
  return reason ? null : { account, key };
}

/**
 * Why a stored URL cannot be turned into a link, as one sentence an operator can
 * act on.
 *
 * This exists because the caller used to be left with nothing: `null` was
 * indistinguishable between "bucket this deployment has never heard of" and "key
 * the signer refuses", and the send fell through to handing Meta the raw bucket
 * URL. That 403s on any private bucket, which reads exactly like "the bucket is
 * not public" -- so the reported cause was wrong in the case most worth
 * reporting correctly.
 *
 * Returns null when the URL is fine, so callers can use it as the test.
 */
export function explainStoredObjectUrl(url) {
  const { reason, bucket } = classifyStoredObjectUrl(url);
  if (!reason) return null;

  const doNotMakePublic =
    `Do not grant public read on the bucket to fix this: doing so would expose ` +
    `every donor PAN, address and amount already stored in it.`;

  if (reason === 'unparseable') {
    return (
      `The receipt PDF's stored URL is not a usable object URL, so no download ` +
      `link can be issued for it. This is a stored-URL problem, not a donor, ` +
      `template or WhatsApp problem. Re-upload the receipt PDF so a usable URL is ` +
      `written. ${doNotMakePublic}`
    );
  }
  if (reason === 'unknown-bucket') {
    const configured = [
      ['HEAD_S3_BUCKET', process.env.HEAD_S3_BUCKET],
      ['UPSTREAM_S3_BUCKET', process.env.UPSTREAM_S3_BUCKET],
      ['S3_BUCKET', process.env.S3_BUCKET],
    ].filter(([, name]) => name).map(([key, name]) => `${key}=${name}`);

    return (
      `The receipt PDF is stored in bucket "${bucket}", which this deployment has ` +
      `no credentials for, so no download link can be issued for it. Configured ` +
      `buckets: ${configured.length ? configured.join(', ') : 'none'}. Either point ` +
      `the matching *_S3_BUCKET variable at "${bucket}" with keys that can read it, ` +
      `or move these receipts into a configured bucket. ${doNotMakePublic}`
    );
  }
  return (
    `The receipt PDF's stored URL has an object key this service refuses to sign ` +
    `("${url}"). Receipt keys must start with a letter or digit and contain only ` +
    `letters, digits, dot, underscore, slash and hyphen, because that same check ` +
    `is what stops the unauthenticated receipt-file endpoint being pointed outside ` +
    `the receipts prefix. This receipt was most likely uploaded under an older ` +
    `filename built from the donor's name, which can contain spaces, commas or ` +
    `non-ASCII characters. Re-upload the PDF to give it a compliant key. ` +
    `${doNotMakePublic}`
  );
}

/**
 * Absolute URL for Meta to fetch. PUBLIC_API_URL wins when set; otherwise the
 * request's own scheme+host is used, which is correct here because the app sits
 * behind Caddy and `trust proxy` is 'loopback'.
 */
export function buildReceiptFileUrl(req, token) {
  const configured = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  const base = configured || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/whatsapp/receipt-file/${token}`;
}