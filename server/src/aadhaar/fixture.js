import zlib from 'node:zlib';

// Builds a synthetic SecureQR payload matching the UIDAI encoding that
// @xone-labs/aadharjs expects:
//   binary = [0x56, version-ascii] + [indicator, referenceId, name, dob,
//            gender, co, district, landmark, house, location, pincode, po,
//            state, street, subdist, vtc] each terminated by 0xFF
//            + signature bytes
//   deflated = zlib.deflate(binary)
//   payload = BigInt('0x' + hex(deflated)) as a decimal string  (the actual
//   encoded content of the QR code is this base-10 number).
export function buildSecureQrPayload({
  indicator = '0',
  referenceId = '85001234567890',
  name = 'Asha Kumari',
  dob = '22-08-1991',
  gender = 'M',
  address = null,
  version = '3',
  signatureSize = 256,
} = {}) {
  const a = address || {};
  const fields = [
    indicator,
    referenceId,
    name,
    dob,
    gender,
    a.co ?? '',
    a.district ?? '',
    a.landmark ?? '',
    a.house ?? '',
    a.location ?? '',
    a.pincode ?? '',
    a.po ?? '',
    a.state ?? '',
    a.street ?? '',
    a.subdist ?? '',
    a.vtc ?? '',
  ];

  const bytes = [0x56, version.charCodeAt(0)];
  for (const field of fields) {
    if (field) bytes.push(...Buffer.from(String(field), 'utf8'));
    bytes.push(0xff);
  }
  for (let i = 0; i < signatureSize; i++) bytes.push(0x01);

  const deflated = zlib.deflateSync(Buffer.from(bytes));
  return BigInt('0x' + deflated.toString('hex')).toString(10);
}

// A realistic SecureQR payload following the UIDAI spec (Annexure / Secure QR
// specification 3.1–3.2):
//   byte array = [indicator(0–3)] [referenceId] [name] [dob] [gender] co,
//   district, landmark, house, location, pincode, post office, state, street,
//   subdist, vtc ... each 0xFF-delimited, then photo + 32-byte email/mobile
//   hashes + 256-byte signature
//   compressed = gzip (real cards are gzip, not zlib)
//   payload    = BigInt(hex(compressed)) as a decimal string
// Note: no 'V' header byte — older implementations wrongly assume one.
export function buildRealSecureQrPayload({
  indicator = '0',
  referenceId = '269720190308114407437',
  name = 'Sumit Kumar',
  dob = '01-01-1984',
  gender = 'M',
  address = null,
} = {}) {
  const a = address || {};
  const fields = [
    indicator,
    referenceId,
    name,
    dob,
    gender,
    a.co ?? '',
    a.district ?? '',
    a.landmark ?? '',
    a.house ?? '',
    a.location ?? '',
    a.pincode ?? '',
    a.po ?? '',
    a.state ?? '',
    a.street ?? '',
    a.subdist ?? '',
    a.vtc ?? '',
  ];

  const bytes = [];
  for (const field of fields) {
    if (field) bytes.push(...Buffer.from(String(field), 'utf8'));
    bytes.push(0xff);
  }
  // Photo blob (kept short here), fixed-size hashes and 256-byte signature.
  for (let i = 0; i < 64; i++) bytes.push(0x47);
  for (let i = 0; i < 32; i++) bytes.push(0x13);
  for (let i = 0; i < 32; i++) bytes.push(0x29);
  for (let i = 0; i < 256; i++) bytes.push(0x01);

  const compressed = zlib.gzipSync(Buffer.from(bytes));
  return BigInt('0x' + compressed.toString('hex')).toString(10);
}

export function sampleAddress() {
  return {
    co: 'C/O Ramesh Kumar',
    house: '12, Gopalpura',
    street: 'Jaipur Road',
    location: 'Tilak Nagar',
    landmark: 'Gandhi Chowk',
    vtc: 'Gopalpura',
    po: 'Gopalpura PO',
    district: 'Jaipur',
    subdist: 'Jaipur',
    state: 'Rajasthan',
    pincode: '302015',
  };
}

// A legacy-format payload the XML fallback decoder in
// utils/aadhaarDecoder.js can read via its layer-1 path: plain base64 of the
// cardholder XML, with the fields stored as attributes (as some older QR
// readers emit them).
export function buildLegacyXmlPayload() {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><UidaiData><Poi name="Asha Rani" dob="22-08-1991" gender="F"/><Poa careof="C/O Ramesh" dist="Jaipur" state="Rajasthan" pc="302015" vtc="Gopalpura"/><Uid>85001234567890</Uid></UidaiData>';
  return Buffer.from(xml, 'utf8').toString('base64');
}