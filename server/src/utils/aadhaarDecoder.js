import zlib from 'zlib';

// ---- Aadhaar SecureQR decoding --------------------------------------------
// The QR on an Aadhaar card encodes the cardholder XML in one of several
// formats that changed over the years:
//   1. plain base64 of the XML,
//   2. base64 of zlib-inflated base64 of the XML,
//   3. base64 of zlib-inflated JSON whose `data` field wraps the XML.
// We try each in turn and return the first that looks like cardholder XML.

const looksLikeXml = (text) => text.includes('<UidaiData') || text.includes('<?xml') || text.includes('<Poi');

const clean = (raw) => (raw || '').replace(/[\s\r\n]+/g, '');

function base64ToText(s) {
  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch (_) {
    return null;
  }
}

function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch (_) {}
  try { return zlib.inflateRawSync(buf); } catch (_) {}
  try { return zlib.gunzipSync(buf); } catch (_) {}
  return null;
}

// JSON-wrapped payloads sometimes nest the XML value in `data` / `xml` and
// that value may itself be base64(lz-compressed(base64(xml))).
function unwrapJsonPayload(json) {
  const data = json?.data || json?.xml || null;
  if (!data) return null;
  const asText = base64ToText(String(data));
  if (asText && looksLikeXml(asText)) return asText;
  const inner = inflate(Buffer.from(String(data), 'base64'));
  if (inner) {
    const t = inner.toString('utf8');
    if (looksLikeXml(t)) return t;
    const innerB64 = base64ToText(t.trim());
    if (innerB64 && looksLikeXml(innerB64)) return innerB64;
  }
  return null;
}

export function decodeAadhaarQr(raw) {
  const s = clean(raw);
  if (!s) return null;

  // Layer 1: plain base64 → XML
  const lvl1 = base64ToText(s);
  if (lvl1 && looksLikeXml(lvl1)) return lvl1;

  // Layer 2: base64(zlib(...)) → XML or base64 XML
  try {
    const b1 = Buffer.from(s, 'base64');
    const inflated = inflate(b1);
    if (inflated) {
      const t = inflated.toString('utf8');
      if (looksLikeXml(t)) return t;
      const innerB64 = base64ToText(t.trim());
      if (innerB64 && looksLikeXml(innerB64)) return innerB64;
      try {
        const json = JSON.parse(t);
        const fromJson = unwrapJsonPayload(json);
        if (fromJson) return fromJson;
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

const decodeEntities = (value = '') =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();

function tagAttrs(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>`));
  if (!m) return {};
  const attrs = {};
  const re = /([A-Za-z_:@.-]+)="([^"]*)"/g;
  let match = null;
  while ((match = re.exec(m[0])) !== null) {
    attrs[match[1]] = decodeEntities(match[2]);
  }
  return attrs;
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decodeEntities(m[1]) : null;
}

const GENDER = { M: 'Male', F: 'Female', O: 'Other', T: 'Transgender' };

// Aadhaar DOB is DD-MM-YYYY; convert to ISO for the beneficiaries table.
function normalizeDob(dob) {
  if (!dob) return null;
  const m = String(dob).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return String(dob);
}

// Extracts the structured fields from decoded cardholder XML.
export function parseAadhaarXml(xml) {
  const poi = tagAttrs(xml, 'Poi');
  const poa = tagAttrs(xml, 'Poa');
  const uid = tagText(xml, 'Uid');
  const pht = tagText(xml, 'Pht');

  const careOf = poa.careof || poi.co || null;
  const house = poa.house || null;
  const street = poa.street || null;
  const landmark = poa.lm || poa.landmark || null;
  const vtc = poa.vtc || poa.po || null;
  const postOffice = poa.poi || null;
  const district = poa.dist || poa.district || null;
  const state = poa.state || null;
  const pincode = poa.pc || poa.pincode || null;

  const addressParts = [careOf, house, street, landmark, vtc, postOffice, district, state, pincode]
    .filter((x) => x)
    .join(', ');

  return {
    aadhaar_number: uid && /^\d{12}$|^\d{4}$/.test(uid) ? uid : uid || null,
    name: poi.name || null,
    dob: normalizeDob(poi.dob),
    gender: poi.gender ? GENDER[poi.gender.toUpperCase()] || poi.gender : null,
    care_of: careOf,
    house,
    street,
    landmark,
    vtc,
    post_office: postOffice,
    district,
    state,
    pincode,
    address_line_1: addressParts || null,
    photo_base64: pht || null,
  };
}