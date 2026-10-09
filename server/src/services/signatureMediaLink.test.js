// This service decides what a browser is allowed to load for a volunteer's legal
// signature. Two failure shapes are worth everything here:
//
//  - signing something that is not a signature (turning a bad column value into a
//    bearer link for another part of the bucket)
//  - not signing something that is (a 403, a blank ODAR letter, a volunteer's
//    record that silently stops being visible)
//
// Credentials below are obviously fake. Presigning is local SigV4 maths, so these
// tests never contact S3.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HEAD_S3_BUCKET = 'ucs-crm-head-uploads';
process.env.HEAD_S3_REGION = 'ap-south-1';
process.env.HEAD_AWS_ACCESS_KEY_ID = 'AKIAFAKEHEADKEY00000';
process.env.HEAD_AWS_SECRET_ACCESS_KEY = 'fake-head-secret-key-for-unit-tests';
process.env.UPSTREAM_S3_BUCKET = 'ucs-crm-uploads-mumbai';
process.env.UPSTREAM_S3_REGION = 'ap-south-1';
process.env.UPSTREAM_AWS_ACCESS_KEY_ID = 'AKIAFAKEUPSTREAM0000';
process.env.UPSTREAM_AWS_SECRET_ACCESS_KEY = 'fake-upstream-secret-key-for-unit-tests';

const { locateSignature, presignSignatureUrl, presignSignatureUrls, ttlSeconds, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS } =
  await import('./signatureMediaLink.js');

const STORED = 'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/worker-documents/worker_signatures/0cc1f2f6-e0eb-4a5e-ae27-9a5e03d23158_1790942419455.png';
const KEY = 'worker-documents/worker_signatures/0cc1f2f6-e0eb-4a5e-ae27-9a5e03d23158_1790942419455.png';

test('the full object URL every existing row holds resolves to account and key', () => {
  assert.deepEqual(locateSignature(STORED), { account: 'upstream', key: KEY });
});

test('a stored URL from the dev bucket resolves against the account that owns it', () => {
  assert.deepEqual(
    locateSignature('https://ucs-crm-head-uploads.s3.ap-south-1.amazonaws.com/worker-documents/worker_signatures/1.png'),
    { account: 'head', key: 'worker-documents/worker_signatures/1.png' }
  );
});

test('a bare key resolves too, so a row migrated to key-only form still signs', () => {
  assert.deepEqual(locateSignature(KEY), { account: 'head', key: KEY });
});

test('a value that is already signed is never re-signed', () => {
  const signed = `${STORED}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261002%2Fap-south-1%2Fs3%2Faws4_request&X-Amz-Signature=deadbeef`;
  assert.equal(locateSignature(signed), null);
});

test('nothing to sign yields null rather than an invented location', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(locateSignature(v), null);
});

test('a bucket this deployment does not manage is refused, never guessed at', () => {
  assert.equal(locateSignature('https://someone-elses-bucket.s3.amazonaws.com/worker-documents/worker_signatures/1.png'), null);
  assert.equal(locateSignature('not-a-url'), null);
});

test('a signature URL cannot be pointed at some other part of the bucket', () => {
  // The prefix check is the whole point: signing is authorised by the IAM
  // identity, so a key outside worker_signatures/ would be a signed link to
  // receipts, Aadhaar images or anything else in the same bucket.
  for (const v of [
    'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/receipts/receipts/1.pdf',
    'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/worker-documents/worker_photos/1.png',
    'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/worker-documents/worker_signatures/../../receipts/receipts/1.pdf',
    'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/',
  ]) {
    assert.equal(locateSignature(v), null, `should refuse: ${v}`);
  }
});

test('a traversal-shaped bare key is refused', () => {
  for (const v of ['worker-documents/worker_signatures/../../root', 'worker-documents/worker_signatures//1.png', '..']) {
    assert.equal(locateSignature(v), null, `should refuse: ${v}`);
  }
});

test('TTL defaults sensibly and is clamped so a link cannot be made permanent', () => {
  const prev = process.env.SIGNATURE_URL_TTL_SECONDS;
  delete process.env.SIGNATURE_URL_TTL_SECONDS;
  assert.equal(ttlSeconds(undefined), DEFAULT_TTL_SECONDS);
  assert.equal(ttlSeconds(0), DEFAULT_TTL_SECONDS);
  assert.equal(ttlSeconds(-1), DEFAULT_TTL_SECONDS);
  assert.equal(ttlSeconds('nonsense'), DEFAULT_TTL_SECONDS);
  assert.equal(ttlSeconds(900), 900);
  assert.equal(ttlSeconds(999 * 24 * 3600), MAX_TTL_SECONDS);

  process.env.SIGNATURE_URL_TTL_SECONDS = '1800';
  assert.equal(ttlSeconds(), 1800);
  process.env.SIGNATURE_URL_TTL_SECONDS = '9999999999';
  assert.equal(ttlSeconds(), MAX_TTL_SECONDS);

  if (prev === undefined) delete process.env.SIGNATURE_URL_TTL_SECONDS;
  else process.env.SIGNATURE_URL_TTL_SECONDS = prev;
});

test('a stored URL comes back signed, for the right bucket and key, with the right lifetime', async () => {
  const url = await presignSignatureUrl(STORED);
  const parsed = new URL(url);
  assert.equal(parsed.host, 'ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com');
  assert.equal(parsed.pathname, `/${KEY}`);
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(parsed.searchParams.get('X-Amz-Signature'), 'expected a SigV4 signature');
  assert.equal(Number(parsed.searchParams.get('X-Amz-Expires')), DEFAULT_TTL_SECONDS);
});

test('the returned URL is not the stored URL', async () => {
  assert.notEqual(await presignSignatureUrl(STORED), STORED);
});

test('an unsigned value is handed back untouched rather than blanked or thrown on', async () => {
  // Invariant 2. A caller that cannot sign a row must still be able to render
  // the value it was given; silently substituting '' would erase a legal record
  // from the response, and throwing would fail an entire worker list.
  for (const v of [
    null,
    '',
    'not-a-url',
    'https://someone-elses-bucket.s3.amazonaws.com/worker-documents/worker_signatures/1.png',
    'https://ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com/receipts/receipts/1.pdf',
  ]) {
    assert.equal(await presignSignatureUrl(v), v == null ? '' : v);
  }
});

test('an already-signed URL is passed through, not signed a second time', async () => {
  const signed = `${STORED}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`;
  assert.equal(await presignSignatureUrl(signed), signed);
});

test('a list signs each entry independently and leaves unsigned gaps alone', async () => {
  const [a, b, c] = await presignSignatureUrls([
    STORED,
    'https://ucs-crm-head-uploads.s3.ap-south-1.amazonaws.com/worker-documents/worker_signatures/2.png',
    null,
  ]);
  assert.ok(a.includes('X-Amz-Signature='));
  assert.equal(new URL(a).host, 'ucs-crm-uploads-mumbai.s3.ap-south-1.amazonaws.com');
  assert.ok(b.includes('X-Amz-Signature='));
  assert.equal(new URL(b).host, 'ucs-crm-head-uploads.s3.ap-south-1.amazonaws.com');
  assert.equal(c, '');
});
