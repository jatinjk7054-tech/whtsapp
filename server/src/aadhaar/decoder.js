import zlib from 'node:zlib';
import { QR } from '@xone-labs/aadharjs';
import {
  decodeAadhaarQr as decodeXmlPayload,
  parseAadhaarXml,
} from '../utils/aadhaarDecoder.js';

// ---- Aadhaar QR decoding service ------------------------------------------
// Decoders tried in order:
//   1. @xone-labs/aadharjs (modern binary SecureQR): the SecureQR encodes its
//      data as a base-10 big integer (per the UIDAI spec) which the package
//      decodes with BigInt() -> bytes -> inflate -> 0xFF-delimited fields.
//   2. A self-contained re-implementation of that same SecureQR decode with
//      extra inflate fallbacks (leading-zero reconstruction, raw/gzip) so we
//      are not limited by whatever the package accepts.
//   3. The project's existing XML decoder (legacy base64/zlib/JSON-wrapped
//      XML cards).
// No Aadhaar data (raw payload or decoded PII) is ever logged or returned.

export class AadhaarDecodeError extends Error {
  /**
   * @param {string} message
   * @param {'invalid' | 'unsupported'} kind
   * @param {Record<string, unknown>} [detail] safe diagnostic metadata (never
   *   includes the raw payload or any decoded field values)
   */
  constructor(message, kind, detail = {}) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

const GENDER_BY_CODE = {
  M: 'Male',
  F: 'Female',
  T: 'Other',
  O: 'Other',
  MALE: 'Male',
  FEMALE: 'Female',
  OTHER: 'Other',
  TRANSGENDER: 'Other',
};

const GENDER_CHOICES = ['Male', 'Female', 'Other'];

function normalizeDob(dob) {
  const s = String(dob ?? '').trim();
  if (!s) return null;
  // Aadhaar QR dob is DD-MM-YYYY; the beneficiaries form expects YYYY-MM-DD.
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function normalizeGender(gender) {
  const s = String(gender ?? '').trim();
  if (!s) return null;
  if (GENDER_CHOICES.includes(s)) return s;
  return GENDER_BY_CODE[s.toUpperCase()] ?? null;
}

// Join address components in a stable order, skipping blanks and removing
// duplicate components so the form never shows "null, null, null".
function buildAddress(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const v = String(part ?? '').trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length > 0 ? out.join(', ') : null;
}

function hasAnyIdentityField(a) {
  if (a.name || a.dob || a.gender) return true;
  return Object.values(a.address || {}).some((v) => String(v ?? '').trim());
}

function normalizePackageOutput(a) {
  return {
    name: String(a.name ?? '').trim() || null,
    dob: normalizeDob(a.dob),
    gender: normalizeGender(a.gender),
    address: buildAddress([
      a.address?.co,
      a.address?.house,
      a.address?.street,
      a.address?.location,
      a.address?.landmark,
      a.address?.vtc,
      a.address?.po,
      a.address?.district,
      a.address?.subdist,
      a.address?.state,
      a.address?.pincode,
    ]),
  };
}

function looksLikeLegacyXml(input) {
  // base64 / zlib / JSON-wrapped XML payloads start with '<' after base64
  // decode. Anything else that fails to decode is treated as simply invalid.
  const cleaned = String(input).replace(/[\s\r\n]+/g, '');
  try {
    const text = Buffer.from(cleaned, 'base64').toString('utf8');
    return text.startsWith('<?xml') || text.includes('<UidaiData') || text.includes('<Poi');
  } catch {
    return false;
  }
}

// Compact, PII-free summary of why a payload failed to decode. Never includes
// the payload itself or any decoded field value.
export function buildFailureDetail(input, opts = {}) {
  const trimmed = String(input ?? '').trim();
  const out = [
    `len=${trimmed.length}`,
    `digits=${/^\d+$/.test(trimmed)}`,
    `url=${/^https?:\/\//i.test(trimmed)}`,
    `xml=${looksLikeLegacyXml(trimmed)}`,
  ];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null) continue;
    out.push(`${k}=${String(v).replace(/[\s\r\n]+/g, ' ').slice(0, 80)}`);
  }
  return out.join(', ');
}

// --- Self-contained SecureQR decode ----------------------------------------
// Mirrors the field layout the @xone-labs package uses but tries several
// inflate variants, including re-adding leading NUL bytes that BigInt() drops
// from the deflated byte stream (some encoders trim them). If no strict
// 'V'-header parse matches, a lenient 0xFF-delimited parse by content
// heuristics is attempted so differently-versioned real cards still resolve.
// Consumed 0xFF-delimited fields in UIDAI order. The first block is the
// mobile/email present-bit indicator (0–3) — sometimes printed with a leading
// "V" + version char baked in — which only occupies a slot we do not validate
// against. Everything after it (referenceId, name, dob, gender, careof,
// district, ... vtc) maps positionally.
const SECURE_FIELD_KEYS = [
  'mobileEmailLink', 'referenceId', 'name', 'dob', 'gender',
  'address.co', 'address.district', 'address.landmark', 'address.house',
  'address.location', 'address.pincode', 'address.po', 'address.state',
  'address.street', 'address.subdist', 'address.vtc', 'lastMobile4Digits',
];

function inflateVariants(raw) {
  const variants = [];
  const attempt = (fn) => {
    try {
      const b = fn();
      if (b && b.length > 0) variants.push(b);
    } catch (_) {}
  };
  const withPad = (buf) =>
    Buffer.concat([Buffer.alloc(buf[0] ?? 0), buf.subarray(1)]);
  attempt(() => zlib.inflateSync(raw));
  attempt(() => zlib.inflateSync(withPad(raw)));
  attempt(() => zlib.inflateRawSync(raw));
  attempt(() => zlib.inflateRawSync(withPad(raw)));
  attempt(() => zlib.gunzipSync(raw));
  attempt(() => zlib.gunzipSync(withPad(raw)));
  return variants;
}

// Parses the UIDAI-spec SecureQR layout positionally: 0xFF-delimited fields in
// a fixed order (indicator, referenceId, name, dob, gender, careof, district,
// landmark, house, location, pincode, post office, state, street, subdist,
// vtc...). The spec has NO 'V' header byte — earlier code wrongly required a
// 0x56 prefix (and a zlib stream), which real cards don't have (they are
// gzip-compressed and start straight with the 0–3 indicator). Validation is
// by field content, not by any magic header.
function parseSecureFields(buf) {
  if (!buf || buf.length === 0) return null;
  const parsed = {};
  let cursor = -1;
  for (const key of SECURE_FIELD_KEYS) {
    const sep = buf.indexOf(0xff, cursor + 1);
    const end = sep === -1 ? buf.length : sep;
    const value = buf.toString('utf8', cursor + 1, end).trim();
    if (key.startsWith('address.')) {
      parsed.address ??= {};
      parsed.address[key.slice(8)] = value;
    } else {
      parsed[key] = value;
    }
    if (sep === -1) break;
    cursor = sep;
  }
  const nameOk = typeof parsed.name === 'string' && /[A-Za-z]{2,}/.test(parsed.name);
  const dobOk =
    typeof parsed.dob === 'string' &&
    (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(parsed.dob) || /^\d{4}$/.test(parsed.dob));
  const genderOk = typeof parsed.gender === 'string' && /^(M|F|T|O|Male|Female|Transgender)$/i.test(parsed.gender);
  if (!nameOk && !dobOk && !genderOk) return null;
  return { __kind: 'structured', ...parsed };
}

// --- Lenient 0xFF-delimited parse (no header assumptions) -------------------
const DATE_RE = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/;
const GENDER_TOKEN = /^(M|F|T|O|Male|Female|Transgender)$/i;
const isPrintable = (s) => /^[\x21-\x7E ]+$/.test(s) && s.trim().length > 0;
const isNameLike = (s) =>
  /[A-Za-z]{2,}/.test(s) && !/\d/.test(s) && s.length >= 2 && s.length <= 50;

function toSegments(buf) {
  const segs = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0xff) {
      if (i > start) segs.push(buf.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  return segs;
}

function toIsoDob(s) {
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!m) return s;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function normalizeGenderToken(s) {
  const u = s.toUpperCase();
  if (u === 'M' || u === 'MALE') return 'Male';
  if (u === 'F' || u === 'FEMALE') return 'Female';
  if (u === 'T' || u === 'O' || u === 'TRANSGENDER' || u === 'OTHER') return 'Other';
  return s;
}

function parseSecureFieldsLenient(buf) {
  const out = {};
  const addressParts = [];
  let collectingAddress = false;
  for (const seg of toSegments(buf)) {
    const s = seg.trim();
    if (s.length < 2 || !isPrintable(s)) continue;
    if (!out.referenceId && /^\d{12,16}$/.test(s)) {
      out.referenceId = s;
      continue;
    }
    if (!out.dob && DATE_RE.test(s)) {
      out.dob = toIsoDob(s);
      collectingAddress = true;
      continue;
    }
    if (!out.gender && GENDER_TOKEN.test(s)) {
      out.gender = normalizeGenderToken(s);
      collectingAddress = true;
      continue;
    }
    if (/^\d{4}$/.test(s)) continue; // lastMobile4Digits
    if (isNameLike(s)) {
      if (!out.name) {
        out.name = s;
      } else {
        addressParts.push(s);
      }
      continue;
    }
    if (collectingAddress) addressParts.push(s);
  }
  if (!out.name && !out.referenceId && !out.dob) return null;
  return {
    __kind: 'lenient',
    name: out.name,
    dob: out.dob,
    gender: out.gender,
    addressString: addressParts.filter((p) => p.trim()).join(', '),
  };
}

const isXmlText = (t) =>
  t.includes('<UidaiData') || t.includes('<?xml') || t.includes('<Poi');

function decodeSecureQrManually(input) {
  const trimmed = String(input ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  let raw;
  try {
    const hex = BigInt(trimmed).toString(16);
    raw = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  } catch {
    return null;
  }
  if (!raw || raw.length < 2) return null;
  for (const buf of inflateVariants(raw)) {
    const strict = parseSecureFields(buf);
    if (strict) return strict;
    const text = buf.toString('utf8');
    if (isXmlText(text)) return { __kind: 'xml', xml: text };
    const lenient = parseSecureFieldsLenient(buf);
    if (lenient) return lenient;
  }
  return null;
}

function normalizeLenientOutput(o) {
  return {
    name: String(o.name ?? '').trim() || null,
    dob: o.dob ? normalizeDob(o.dob) : null,
    gender: o.gender ? normalizeGender(o.gender) ?? o.gender : null,
    address: String(o.addressString ?? '').trim() || null,
  };
}

function mapXmlFields(fields) {
  return {
    name: String(fields.name ?? '').trim() || null,
    dob: normalizeDob(fields.dob),
    gender: normalizeGender(fields.gender),
    address: String(fields.address_line_1 ?? '').trim() || null,
  };
}

// Package errors must never reach logs/responses verbatim: a BigInt
// SyntaxError embeds the raw input string in its message. Map to a safe token.
function safePackageError(e) {
  if (!e) return null;
  if (e instanceof SyntaxError) return 'BigIntSyntaxError';
  return String(e?.name || 'Error');
}

// Returns { name, dob, gender, address } or throws an AadhaarDecodeError.
export function decodeAadhaarQr(raw) {
  const input = String(raw ?? '').trim();
  if (!input) {
    throw new AadhaarDecodeError('QR data is required', 'invalid');
  }

  // 1) Modern binary SecureQR via @xone-labs/aadharjs.
  let pkgError = null;
  try {
    const packageResult = QR.decode(input);
    if (packageResult && hasAnyIdentityField(packageResult)) {
      return normalizePackageOutput(packageResult);
    }
  } catch (error) {
    pkgError = error;
  }

  // 2) Self-contained SecureQR decode (inflate fallbacks + lenient parse).
  const manual = decodeSecureQrManually(input);
  if (manual && manual.__kind === 'structured' && hasAnyIdentityField(manual)) {
    return normalizePackageOutput(manual);
  }
  if (manual && manual.__kind === 'lenient' && (manual.name || manual.dob || manual.gender)) {
    return normalizeLenientOutput(manual);
  }
  if (manual && manual.__kind === 'xml') {
    const xmlFields = parseAadhaarXml(manual.xml);
    if (xmlFields && (xmlFields.name || xmlFields.aadhaar_number)) {
      return mapXmlFields(xmlFields);
    }
  }

  // 3) Legacy XML-format cards via the existing XML decoder.
  const xml = decodeXmlPayload(input);
  if (xml) {
    const fields = parseAadhaarXml(xml);
    if (fields && (fields.name || fields.aadhaar_number)) {
      return mapXmlFields(fields);
    }
  }

  // 4) Classify the failure.
  if (looksLikeLegacyXml(input)) {
    throw new AadhaarDecodeError('Unsupported Aadhaar QR format', 'unsupported', {
      pkg: safePackageError(pkgError),
    });
  }
  throw new AadhaarDecodeError('Invalid Aadhaar QR', 'invalid', {
    pkg: safePackageError(pkgError),
  });
}