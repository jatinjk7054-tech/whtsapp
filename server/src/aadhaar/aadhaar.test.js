import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { QR } from '@xone-labs/aadharjs';
import { decodeAadhaarQr, AadhaarDecodeError } from './decoder.js';
import aadhaarRouter from './routes.js';
import { buildSecureQrPayload, buildLegacyXmlPayload, buildRealSecureQrPayload, sampleAddress } from './fixture.js';

const validSecureQr = buildSecureQrPayload({ address: sampleAddress(), name: 'Asha Kumari', gender: 'M', dob: '22-08-1991' });
const legacyXmlQr = buildLegacyXmlPayload();
const realSecureQr = buildRealSecureQrPayload({ address: sampleAddress(), name: 'Sumit Kumar', gender: 'M', dob: '01-01-1984' });

// ---- decoder unit tests -----------------------------------------------------

test('decodes a modern binary SecureQR into normalized fields', () => {
  const out = decodeAadhaarQr(validSecureQr);
  assert.equal(out.name, 'Asha Kumari');
  assert.equal(out.dob, '1991-08-22');
  assert.equal(out.gender, 'Male');
  assert.ok(out.address.includes('Tilak Nagar'));
  assert.ok(out.address.includes('Gandhi Chowk'));
  assert.ok(out.address.includes('302015'));
  assert.ok(!out.address.includes('Jaipur, Jaipur'), 'duplicate district component still in address');
});

test('falls back to the legacy XML decoder', () => {
  const out = decodeAadhaarQr(legacyXmlQr);
  assert.equal(out.name, 'Asha Rani');
  assert.equal(out.dob, '1991-08-22');
  assert.equal(out.gender, 'Female');
  assert.ok(out.address.includes('Jaipur'));
  assert.ok(out.address.includes('302015'));
});

test('decodes a spec-real SecureQR (gzip, no V header) into normalized fields', () => {
  const out = decodeAadhaarQr(realSecureQr);
  assert.equal(out.name, 'Sumit Kumar');
  assert.equal(out.dob, '1984-01-01');
  assert.equal(out.gender, 'Male');
  assert.ok(out.address.includes('Tilak Nagar'));
  assert.ok(out.address.includes('Gandhi Chowk'));
  assert.ok(out.address.includes('302015'));
});

test('rejects an empty payload as invalid', () => {
  for (const input of ['', '   ', null, undefined]) {
    assert.throws(() => decodeAadhaarQr(input), (e) => e instanceof AadhaarDecodeError && e.kind === 'invalid');
  }
});

test('rejects garbage input as invalid', () => {
  assert.throws(() => decodeAadhaarQr('this is not an aadhaar qr'), (e) => e instanceof AadhaarDecodeError && e.kind === 'invalid');
});

// ---- route integration tests ------------------------------------------------

const JWT_SECRET = 'test-secret-123';
process.env.JWT_SECRET = JWT_SECRET;

function buildServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/aadhaar', aadhaarRouter);
  return http.createServer(app);
}

function tokenFor(role) {
  return jwt.sign({ id: 't1', name: 'Test Worker', role }, JWT_SECRET);
}

async function post(server, path, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function withServer(fn) {
  const server = buildServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(server);
  } finally {
    server.close();
  }
}

test('POST /decode-qr returns decoded data for a valid SecureQR', async () => {
  await withServer(async (server) => {
    const { status, json } = await post(server, '/api/aadhaar/decode-qr', {
      body: { qrData: validSecureQr },
      token: tokenFor('worker'),
    });
    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.name, 'Asha Kumari');
    assert.equal(json.data.dob, '1991-08-22');
    assert.equal(json.data.gender, 'Male');
    assert.ok(json.data.address.includes('302015'));
  });
});

test('POST /decode-qr requires an auth token', async () => {
  await withServer(async (server) => {
    const { status } = await post(server, '/api/aadhaar/decode-qr', { body: { qrData: validSecureQr } });
    assert.equal(status, 401);
  });
});

test('POST /decode-qr rejects disallowed roles', async () => {
  await withServer(async (server) => {
    const { status } = await post(server, '/api/aadhaar/decode-qr', {
      body: { qrData: validSecureQr },
      token: tokenFor('viewer'),
    });
    assert.equal(status, 403);
  });
});

test('POST /decode-qr requires qrData in the body', async () => {
  await withServer(async (server) => {
    const { status, json } = await post(server, '/api/aadhaar/decode-qr', {
      body: {},
      token: tokenFor('worker'),
    });
    assert.equal(status, 400);
    assert.equal(json.message, 'QR data is required');
  });
});

test('POST /decode-qr returns 400 for an unreadable payload', async () => {
  await withServer(async (server) => {
    const { status, json } = await post(server, '/api/aadhaar/decode-qr', {
      body: { qrData: 'garbage-not-a-qr' },
      token: tokenFor('worker'),
    });
    assert.equal(status, 400);
    assert.equal(json.message, 'Invalid Aadhaar QR');
    // Safe diagnostic metadata accompanies the error (length + format flags),
    // never the payload itself.
    assert.ok(json.detail.includes('len='));
  });
});

// ---- documented limitation --------------------------------------------------

test('documented: @xone-labs/aadharjs cannot read raw base64 payloads', () => {
  // QR.decode feeds the whole string to BigInt(), so a base64 QR value (old
  // XML format) throws SyntaxError. Our legacy fallback handles those.
  const base64Like = Buffer.from('anything').toString('base64');
  assert.throws(() => QR.decode(base64Like), SyntaxError);
});