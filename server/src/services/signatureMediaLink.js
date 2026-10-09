// Turns a stored volunteer signature into a URL a browser can actually load.
//
// Why this exists: `db.storage.getPublicUrl()` (config/db.js) builds a raw,
// unsigned https://<bucket>.s3.<region>.amazonaws.com/... string, and that string
// is what workers.signature_url has always held. It worked only while the bucket
// granted `Principal: "*"` on s3:GetObject. The 2026-09-30 containment
// (docs/security/S3-PII-EXPOSURE-REMEDIATION.md, Phase 2) set all four
// public-access-block flags, which makes that grant inert -- so every stored
// signature URL now answers 403 and the ODAR letter prints a blank line.
//
// The bucket is not being reopened. Instead the backend signs a short-lived
// GetObject URL with credentials it already holds, and hands that to the client.
// This is Phase 3 of that same document, scoped to signatures only.
//
// Two invariants matter more than the mechanics:
//
// 1. A signed URL is NEVER persisted. A signed URL in the database is a
//    capability with an expiry baked into a row nobody will ever refresh, and
//    `signature_previous_url` would freeze one at the moment of a re-sign. The
//    column keeps holding the plain object URL; only responses carry a signature.
// 2. A value this function does not understand is returned untouched. It runs on
//    a column full of history, so "I cannot sign this" has to mean "hand back what
//    was stored" rather than blanking a legal record or throwing in a list
//    endpoint. An unsigned URL that now 403s is still a better answer to a caller
//    than a thrown error, and it makes the failure visible instead of silent.

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import db from '../config/db.js';
import { describeStoredObjectUrl, isSafeKey } from './receiptFileLink.js';

// Objects live at <prefix>/worker_signatures/<file>. The prefix is the s3Key()
// bucket argument, so the full key repeats it -- see config/db.js s3Key(). This
// is a scoping check, not the authorisation: only ever used to refuse a key that
// does not look like a signature, so a bad column value cannot be turned into a
// signed link to some other part of the bucket.
const SIGNATURE_PREFIX = 'worker-documents/worker_signatures/';

// Long enough to cover an HR session -- the ODAR letter is built in the browser
// from a worker list fetched when the panel opens, and a volunteer leaving the
// page open must not silently lose their own signature -- while still expiring
// quickly enough that a URL pasted elsewhere stops working the same hour.
export const DEFAULT_TTL_SECONDS = 60 * 60;

// Ceiling from the receipt link service, reused so there is one house rule about
// how long anything in this system may hand out a bearer link. A signature is a
// legal record, so a leaked one is worse than a leaked receipt, not better.
export const MAX_TTL_SECONDS = 6 * 60 * 60;

// A presigned URL carries these in its query string. Seeing one means the value
// is already signed and must be passed through: re-signing a signed URL would
// sign a URL, and some consumers treat the result as the stored reference.
const SIGNED_MARKERS = ['X-Amz-Signature=', 'X-Amz-Credential=', 'X-Amz-Algorithm='];

/**
 * Seconds a signature link may live. Clamped rather than merely defaulted, so a
 * bad or hostile env value cannot turn this into a permanent public link.
 */
export function ttlSeconds(override) {
  const n = Number(override ?? process.env.SIGNATURE_URL_TTL_SECONDS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(n), MAX_TTL_SECONDS);
}

const isPresigned = (value) => SIGNED_MARKERS.some((m) => value.includes(m));

/**
 * Maps a stored `signature_url` onto the S3 account and object key that hold it.
 *
 * Accepts both forms on purpose:
 *   - a full object URL, which is what every existing row holds
 *   - a bare key, so a row migrated to the key-only form recommended in Phase 3
 *     of the remediation doc keeps resolving with no further changes
 *
 * Returns null when the value is absent, already signed, points at a bucket this
 * deployment does not manage, or is not a signature object. Callers treat null as
 * "return the stored value unchanged".
 */
export function locateSignature(stored) {
  const value = String(stored ?? '').trim();
  if (!value) return null;
  if (isPresigned(value)) return null;

  let account = null;
  let key = null;

  if (/^https?:\/\//i.test(value)) {
    const described = describeStoredObjectUrl(value);
    if (!described) return null;
    account = described.account;
    key = described.key;
  } else {
    // A bare key carries no bucket, so it is resolved against the same account
    // the single-argument storage calls use. If a future migration stores keys
    // this is the only line that has to know it.
    const handle = db.storage.raw() || db.storage.raw('head');
    if (!handle) return null;
    account = handle.account;
    key = value;
  }

  // isSafeKey is the reason a prefix check is not enough on its own: S3 resolves
  // `..` within a key, so `worker_signatures/../../receipts/1.pdf` satisfies
  // startsWith() and still addresses a different object. Checked for bare keys
  // here because a URL input has already been through it inside
  // describeStoredObjectUrl(); applying it to both keeps the invariant local.
  if (!isSafeKey(key) || !key.startsWith(SIGNATURE_PREFIX)) return null;
  return { account, key };
}

/**
 * The signed URL a client should load, or `stored` unchanged when it cannot be
 * signed (see invariant 2). Never throws: this is called per row while building
 * a list response, and one unresolvable row must not fail the whole request.
 *
 * Presigning is local SigV4 maths against the client from storage.raw(), with no
 * S3 request, so signing every worker's signature in a list costs no round trips.
 */
export async function presignSignatureUrl(stored) {
  const original = String(stored ?? '');
  const located = locateSignature(original);
  if (!located) return original;

  const handle = db.storage.raw(located.account);
  if (!handle) return original;

  try {
    return await getSignedUrl(
      handle.client,
      new GetObjectCommand({ Bucket: handle.bucket, Key: located.key }),
      { expiresIn: ttlSeconds() }
    );
  } catch (e) {
    console.warn(`[signature] could not presign ${located.account}/${located.key}: ${e?.message || e}`);
    return original;
  }
}

/**
 * Same, over a list. Presigning is independent per object, so this is a plain
 * map and one failure still leaves every other signature usable.
 */
export function presignSignatureUrls(list) {
  return Promise.all((Array.isArray(list) ? list : []).map((v) => presignSignatureUrl(v)));
}
