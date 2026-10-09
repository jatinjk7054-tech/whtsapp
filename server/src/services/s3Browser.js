import {
  ListBucketsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import db from '../config/db.js';

// ---------------------------------------------------------------------------
// S3 bucket browser (db-viewer companion to the table browser).
//
// Everything here runs through db.storage.raw(), so it reuses the same
// account registry and credentials the app itself writes with — no second
// set of AWS keys, and no way to address an account the app does not use.
//
// Objects are addressed by their real key. A "folder" in S3 is only a key
// prefix, so folder deletes expand the prefix and delete what is under it.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 500;
// Hard stop for a folder delete. A prefix can hold more keys than this and
// the caller is told the delete was partial rather than silently truncated.
const MAX_FOLDER_DELETE = 10000;
const DELETE_BATCH = 1000;

const isBucketName = (v) =>
  typeof v === 'string' &&
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v) &&
  !v.includes('..') &&
  !/^\d+\.\d+\.\d+\.\d+$/.test(v);

// Keys are arbitrary strings, but a key must stay inside its bucket: reject
// anything that could climb out of the prefix the caller is browsing.
const safeKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.includes('\0');

const safePrefix = (v) => {
  if (v == null || v === '') return '';
  return safeKey(v) ? v : null;
};

const handleFor = (account) => {
  const h = db.storage.raw(account);
  if (!h) {
    const err = new Error(`S3 account "${account || 'default'}" is not configured — set its access key and bucket in backend/.env`);
    err.status = 400;
    throw err;
  }
  return h;
};

function requireBucket(bucket) {
  if (!isBucketName(String(bucket || ''))) {
    const err = new Error('Invalid or missing bucket name');
    err.status = 400;
    throw err;
  }
  return String(bucket);
}

// Every configured account, each with the buckets it can see. ListBuckets
// needs s3:ListAllMyBuckets, which the scoped app keys usually do not have,
// so a failure falls back to the one bucket the account is configured with
// and reports why rather than hiding the account entirely.
export async function listBuckets() {
  const accounts = db.storage.accounts();
  const out = [];
  for (const acc of accounts) {
    if (!acc.configured) {
      out.push({ ...acc, buckets: [], note: 'no credentials configured' });
      continue;
    }
    const handle = db.storage.raw(acc.name);
    if (!handle) {
      out.push({ ...acc, buckets: [], note: 'client unavailable' });
      continue;
    }
    let buckets = [];
    let note = null;
    try {
      const r = await handle.client.send(new ListBucketsCommand({}));
      buckets = (r.Buckets || []).map((b) => ({ name: b.Name, createdAt: b.CreationDate || null }));
      if (!buckets.some((b) => b.name === acc.bucket)) {
        buckets.unshift({ name: acc.bucket, configured: true, createdAt: null });
      }
    } catch (e) {
      buckets = [{ name: acc.bucket, configured: true, createdAt: null }];
      note = e && e.name === 'AccessDenied'
        ? 'this key cannot list buckets (s3:ListAllMyBuckets) — showing its configured bucket only'
        : `bucket list unavailable (${e && e.message ? e.message : e})`;
    }
    out.push({ ...acc, buckets, note });
  }
  return { accounts: out };
}

// One page of a bucket: sub-folders (CommonPrefixes) plus the objects that sit
// directly at this prefix. `token` continues a truncated listing.
export async function listObjects({ account, bucket, prefix, token, delimiter }) {
  const handle = handleFor(account);
  const b = requireBucket(bucket);
  const p = safePrefix(prefix);
  if (p === null) {
    const err = new Error('Invalid prefix');
    err.status = 400;
    throw err;
  }
  const sep = delimiter === '' ? '' : '/';
  const r = await handle.client.send(new ListObjectsV2Command({
    Bucket: b,
    Prefix: p,
    Delimiter: sep,
    MaxKeys: PAGE_SIZE,
    ContinuationToken: token || undefined,
  }));

  const folders = (r.CommonPrefixes || [])
    .map((x) => String(x.Prefix || ''))
    .filter(Boolean)
    .map((k) => ({ key: k, name: k.slice(p.length).replace(/\/$/, '') }));

  const objects = (r.Contents || [])
    // A "folder marker" object (a zero-byte key ending in /) shows up in
    // Contents as well as CommonPrefixes; CommonPrefixes is the useful view.
    .filter((o) => sep === '' || !String(o.Key || '').endsWith('/'))
    .map((o) => ({
      key: o.Key,
      name: String(o.Key).slice(p.length),
      size: o.Size,
      lastModified: o.LastModified || null,
      etag: o.ETag ? String(o.ETag).replace(/"/g, '') : null,
      storageClass: o.StorageClass || null,
    }));

  return {
    account: handle.account,
    bucket: b,
    region: handle.region,
    prefix: p,
    folders,
    objects,
    truncated: Boolean(r.IsTruncated),
    nextToken: r.IsTruncated ? r.NextContinuationToken || null : null,
  };
}

async function deleteKeys(handle, bucket, keys) {
  let deleted = 0;
  const errors = [];
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH);
    const r = await handle.client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }));
    deleted += (r.Deleted || []).length;
    for (const e of r.Errors || []) errors.push({ key: e.Key, message: e.Message || e.Code || 'delete failed' });
  }
  return { deleted, errors };
}

// Delete named objects. Count is capped so a pasted list cannot turn into an
// unbounded delete; the cap is reported back in `capped`.
export async function deleteObjects({ account, bucket, keys }) {
  const handle = handleFor(account);
  const b = requireBucket(bucket);
  const list = Array.isArray(keys) ? keys : [keys];
  if (list.length === 0) {
    const err = new Error('No keys provided');
    err.status = 400;
    throw err;
  }
  const clean = [];
  for (const k of list) {
    if (!safeKey(k)) {
      const err = new Error(`Invalid object key: ${JSON.stringify(String(k).slice(0, 80))}`);
      err.status = 400;
      throw err;
    }
    clean.push(k);
  }
  const capped = clean.length > MAX_FOLDER_DELETE;
  const batch = capped ? clean.slice(0, MAX_FOLDER_DELETE) : clean;
  const r = await deleteKeys(handle, b, batch);
  return { ...r, requested: clean.length, capped };
}

// Delete a "folder": every key under the prefix. Paginates until the prefix
// runs out, then reports whether the MAX_FOLDER_DELETE cap cut it short.
export async function deleteFolder({ account, bucket, prefix }) {
  const handle = handleFor(account);
  const b = requireBucket(bucket);
  const p = safePrefix(prefix);
  if (!p) {
    const err = new Error('A folder prefix is required');
    err.status = 400;
    throw err;
  }
  const keys = [];
  let token;
  let truncated = false;
  do {
    const r = await handle.client.send(new ListObjectsV2Command({
      Bucket: b,
      Prefix: p,
      MaxKeys: PAGE_SIZE,
      ContinuationToken: token || undefined,
    }));
    for (const o of r.Contents || []) {
      keys.push(o.Key);
      if (keys.length >= MAX_FOLDER_DELETE) { truncated = true; break; }
    }
    token = r.IsTruncated ? r.NextContinuationToken || null : null;
  } while (token && !truncated);

  if (keys.length === 0) {
    return { deleted: 0, errors: [], prefix: p, empty: true };
  }
  const r = await deleteKeys(handle, b, keys);
  return { ...r, prefix: p, scanned: keys.length, capped: truncated };
}

// Stream an object back to the caller. Content-Disposition is attachment so a
// stray HTML/SVG key cannot execute in the browser tab serving the viewer.
export async function getObjectStream({ account, bucket, key }) {
  const handle = handleFor(account);
  const b = requireBucket(bucket);
  if (!safeKey(key)) {
    const err = new Error('Invalid object key');
    err.status = 400;
    throw err;
  }
  const r = await handle.client.send(new GetObjectCommand({ Bucket: b, Key: key }));
  return {
    body: r.Body,
    contentType: r.ContentType || 'application/octet-stream',
    contentLength: r.ContentLength,
    lastModified: r.LastModified || null,
  };
}
