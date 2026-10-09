// Tests for storage.presignDownload().
//
// This exists because of a bug that was invisible from the API response and cost
// real time to find. A test signed an S3 presigned URL for `receipts/x.pdf` when
// the upload had actually gone to `receipts/receipts/x.pdf`, because the storage
// handle for prefix "receipts" prepends the prefix itself. The URL was
// well-formed and correctly expiring -- it simply 404'd, which reads exactly
// like "Meta could not download the file" and sent the debugging after the media
// instead of after the key.
//
// So the property under test is not "returns a string". It is "signs the same
// object upload() writes and readStream() reads" -- which means going through the
// shared key resolution, never a hand-assembled key.
//
// Signing is entirely local (no network), so the presign assertions run against
// the real configured account. When S3 credentials are absent the suite skips
// rather than fails, so it stays useful in a bare checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { storage, s3Key } from './db.js';

const store = storage.from('legacy', 'receipts');
const configured = Boolean(store.accountName);
const opts = { skip: configured ? false : 'no S3 account configured' };

test('s3Key puts the handle prefix in front of the caller key exactly once', () => {
  assert.equal(s3Key('b', 'receipt-1.pdf'), 'b/receipt-1.pdf');
  // The trap: a caller that re-adds the prefix it already handed to from().
  assert.notEqual(s3Key('b', 'r.pdf'), s3Key('b', 'receipts/r.pdf'));
});

test('presignDownload signs the key the handle prefix produces', opts, async () => {
  const res = await store.presignDownload('receipt-1.pdf');
  assert.equal(res.error, null);
  const url = new URL(res.data.url);
  // Virtual-hosted style: the bucket is the host, the key is the path.
  assert.equal(url.pathname, '/receipts/receipt-1.pdf');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

test('presignDownload keeps a doubled prefix distinguishable, so the wrong key cannot pass silently', opts, async () => {
  const viaHandle = await store.presignDownload('r.pdf');
  const viaDoubled = await store.presignDownload('receipts/r.pdf');

  assert.notEqual(new URL(viaHandle.data.url).pathname, new URL(viaDoubled.data.url).pathname);
  assert.equal(new URL(viaHandle.data.url).pathname, new URL(viaDoubled.data.url).pathname.replace('/receipts/receipts/', '/receipts/'));
});

test('presignDownload clamps a nonsensical expiry instead of passing it to S3', opts, async () => {
  const zero = await store.presignDownload('r.pdf', 0);
  assert.equal(zero.error, null, '0 must fall back to the default, not fail');
  assert.equal(new URL(zero.data.url).searchParams.get('X-Amz-Expires'), '3600');

  const negative = await store.presignDownload('r.pdf', -99);
  assert.equal(
    new URL(negative.data.url).searchParams.get('X-Amz-Expires'),
    '3600',
    'a garbage expiry must fall back to the default, never shorten a live receipt link to 60s',
  );

  const nan = await store.presignDownload('r.pdf', 'not-a-number');
  assert.equal(new URL(nan.data.url).searchParams.get('X-Amz-Expires'), '3600');

  const absurd = await store.presignDownload('r.pdf', 10 ** 9);
  assert.equal(
    new URL(absurd.data.url).searchParams.get('X-Amz-Expires'),
    String(7 * 24 * 60 * 60),
    'must clamp to the 7 day ceiling rather than ask S3 for something it refuses',
  );
});

test('presignDownload returns a result object with an error instead of throwing', async () => {
  const unconfigured = storage.from(null, 'receipts');
  if (unconfigured.accountName) return; // credentials present, nothing to assert here
  const res = await unconfigured.presignDownload('r.pdf');
  assert.equal(res.data, null);
  assert.ok(res.error.message, 'an unconfigured handle must explain itself');
});