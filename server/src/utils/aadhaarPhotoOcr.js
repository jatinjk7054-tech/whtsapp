import FormData from 'form-data';

// Fallback model chain: the vision model used for Aadhaar photo OCR. Free keys
// get deprecated quickly (gemini-2.5-flash is gone for new users, Gemini's API
// redirects to gemini-3.8-flash), so we always try the configured model first,
// then rotate through the known-good defaults, skipping models the API reports
// as "no longer available".
const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
const GEMINI_MODELS = (() => {
  const chain = [];
  if (process.env.GEMINI_MODEL) chain.push(process.env.GEMINI_MODEL);
  for (const m of DEFAULT_MODELS) if (!chain.includes(m)) chain.push(m);
  return chain;
})();
const GEMINI_MODEL = GEMINI_MODELS[0];

// Regex heuristics used only when vision OCR is unavailable. The front side of
// an Aadhaar card is fairly regular: name near the top, DOB / Gender lines, an
// address block, and the 12-digit number (possibly masked) near the bottom.
const STATE_NAMES = [
  'Andaman and Nicobar', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli', 'Daman and Diu', 'Delhi',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand',
  'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal',
];

function parseDob(raw) {
  const m = String(raw || '').match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (!m) return null;
  let [d, mo, y] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  if (d > 31 && mo <= 12) { const t = d; d = mo; mo = t; }
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// Best-effort field extraction from a blob of OCR text.
export function parseAadhaarFromText(text = '') {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/[|_]/g, '').trim())
    .filter(Boolean);

  const joined = lines.join('\n');
  const out = {};

  // Aadhaar number: "1234 5678 9012" or 12 contiguous digits (allow masks).
  const numMatch =
    joined.match(/\b\d{4}[ ]\d{4}[ ]\d{4}\b/) ||
    joined.match(/\b\d{12}\b/);
  if (numMatch) out.aadhaar_number = numMatch[0].replace(/[^0-9]/g, '');

  // DOB line like "DOB: 12/03/1990" / "Date of Birth : 12-03-1990".
  const dobLine = joined.match(/(?:DOB|Date of Birth|Birth)[^\d]{0,20}(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/i);
  if (dobLine) {
    const parsed = parseDob(dobLine[1]);
    if (parsed) out.dob = parsed;
  }

  // Gender: "Gender : Male" or a lone "Male"/"Female"/"Transgender".
  const gMatch =
    joined.match(/(?:Gender|Sex)[^\d]{0,25}(Male|Female|Transgender)/i) ||
    joined.match(/^(Male|Female|Transgender)$/im);
  if (gMatch) out.gender = gMatch[1][0].toUpperCase() + gMatch[1].slice(1).toLowerCase();

  // Pincode: a 6-digit number not used as the Aadhaar UID.
  const pinMatch = joined.match(/\b[1-9]\d{5}\b/);
  if (pinMatch) {
    const pin = pinMatch[0];
    if (!out.aadhaar_number || !pin.startsWith(out.aadhaar_number.slice(0, 2))) {
      out.pincode = pin;
    }
  }

  // State: pick the best-known state name present.
  const state = STATE_NAMES.find((s) =>
    s.split(' ').length > 1
      ? joined.toLowerCase().includes(s.toLowerCase())
      : new RegExp(`\\b${s}\\b`, 'i').test(joined),
  );
  if (state) out.state = state;

  // Address: collect the block between the DOB/Gender lines and the number/
  // pincode at the bottom, dropping known labels and short noise lines.
  const addrStart = lines.findIndex(
    (l) => /Gender|DOB|Date of Birth|Address/i.test(l),
  );
  const addrEnd = lines.length;
  const stopIdx = lines.findIndex((l) => /\b\d{6}\b/.test(l));
  const addrLines = lines.slice(addrStart + 1, stopIdx > -1 ? stopIdx : addrEnd)
    .map((l) => l
      .replace(/^Address[:\- ]*/i, '')
      .replace(/\b\d{4}[ ]?\d{4}[ ]?\d{4}\b/g, '')
      .trim())
    .filter((l) => l && l.length >= 3 && !/^(Male|Female|Transgender|India|Government of India)$/i.test(l));

  if (addrLines.length) {
    out.address_line_1 = addrLines.join(', ');
    out.vtc = addrLines[0];
  }

  // Name: the first "name-like" line near the top (skips headers and labels).
  const nameLine = lines.find(
    (l) =>
      l.length >= 3 &&
      l.length <= 60 &&
      /[A-Za-z]{2,}/.test(l) &&
      !/^(Government|मोहन|Mohan|UIDAI|Unique|Identification|Authority|India|Address|Gender|DOB|Date of Birth|Enrolment|Enrollment)/i.test(l) &&
      !/\d/.test(l),
  );
  if (nameLine) out.name = nameLine.replace(/^[:\- ]+|[:\- ]+$/g, '');

  return out;
}

function toRawBase64(base64) {
  return base64.includes('base64,') ? base64.split('base64,')[1] : base64;
}

// Keeps only usable fields and normalizes aadhaar_number / dob, mirroring the
// QR decoder's field shape so the app auto-fills identically. Which fields are
// kept depends on the card side: the FRONT carries name/DOB/gender and the
// masked 12-digit number; the BACK carries the address block; 'all' keeps
// everything visible in the photo (used when a single uploaded document should
// be scraped for every detail — no city/state decomposition, one address_line_1).
const FRONT_KEYS = ['name', 'dob', 'gender', 'aadhaar_number'];
const BACK_KEYS = ['address_line_1', 'vtc'];
export const ALL_KEYS = ['name', 'dob', 'gender', 'address_line_1', 'vtc', 'aadhaar_number', 'pincode'];

function keysForSide(side) {
  if (side === 'back') return BACK_KEYS;
  if (side === 'front') return FRONT_KEYS;
  return ALL_KEYS;
}

function cleanFields(parsed, allowedKeys) {
  const cleaned = {};
  for (const k of allowedKeys) {
    const v = parsed?.[k];
    if (v != null && String(v).trim() !== '') cleaned[k] = String(v).trim();
  }
  if (cleaned.aadhaar_number) {
    cleaned.aadhaar_number = String(cleaned.aadhaar_number).replace(/[^0-9]/g, '').slice(0, 12);
  }
  const dob = parseDob(cleaned.dob);
  if (dob) cleaned.dob = dob;
  return cleaned;
}

function buildPrompt(side) {
  if (side === 'back') {
    return [
      'You read the BACK side of an Aadhaar card, which shows the address table.',
      'Reply with ONLY a JSON object. Extract exactly these keys (null if not visible):',
      '{"address_line_1"}',
      'address_line_1 must be the full address as a single comma-separated string.',
      'Do not extract the name, DOB or Aadhaar number. Do not invent anything.',
    ].join(' ');
  }
  if (side === 'front') {
    return [
      'You read the FRONT side of an Aadhaar card.',
      'Reply with ONLY a JSON object. Extract exactly these keys (null if not visible):',
      '{"name","dob","gender","aadhaar_number"}',
      'dob must be YYYY-MM-DD. aadhaar_number must be 12 digits with no spaces.',
      'Do not invent values that are not on the card.',
    ].join(' ');
  }
  return [
    'You read an Aadhaar card photo.',
    'Reply with ONLY a JSON object. Extract exactly these keys (null if not visible):',
    '{"name","dob","gender","address_line_1","aadhaar_number","pincode"}',
    'name is the cardholder name. dob must be YYYY-MM-DD.',
    'aadhaar_number must be 12 contiguous digits with no spaces.',
    'address_line_1 must be the full address as one comma-separated string if any address text is visible.',
    'pincode must be the 6-digit postal code if any address text is visible (omit when absent).',
    'Do not invent values that are not on the card.',
  ].join(' ');
}

// Gemini REST (generativelanguage.googleapis.com). The free API key only
// works through the /v1beta top-level key query endpoint. Fails loudly so the
// caller can report which OCR engine was missing/broken. Tries each model in
// the chain; on "no longer available" it skips ahead, on 503/429 (high demand
// / quota) it retries with a short backoff, then moves to the next model.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function extractWithGemini(base64, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server');

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        const endpoint =
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: 'image/jpeg', data: toRawBase64(base64) } },
                ],
              },
            ],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 },
          }),
        });
      } catch (e) {
        lastError = e;
        break; // network failure — try the next model
      }

      if (res.ok) {
        const json = await res.json();
        const text = (json.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? '')
          .join('')
          .trim();
        if (text) return JSON.parse(text.replace(/```json|```/g, '').trim());
        return null;
      }

      const body = await res.text();
      const msg = `Gemini HTTP ${res.status}: ${body.slice(0, 300)}`;
      if (/no longer available|does not exist/i.test(msg)) {
        lastError = new Error(msg);
        break; // model retired — try the next model
      }
      if (res.status === 503 || res.status === 429) {
        if (attempt < 2) {
          await sleep(600 * (attempt + 1));
          continue; // transient overload — retry same model
        }
        lastError = new Error(msg);
        break; // still overloaded — try the next model
      }
      throw new Error(msg);
    }
  }
  throw lastError ?? new Error('no Gemini model available');
}

// Fallback OCR.space engine. Fails loudly with its HTTP/parse status when the
// OCR service itself rejects the request or needs its API key.
async function extractWithOcrSpace(base64, allowedKeys) {
  const key = process.env.OCR_SPACE_KEY;
  if (!key) throw new Error('OCR_SPACE_KEY is not set on the server');
  const form = new FormData();
  form.append('base64image', toRawBase64(base64));
  form.append('language', 'eng');
  form.append('filetype', 'JPG');
  form.append('isOverlayRequired', 'false');
  form.append('isTable', 'true');

  const ocrRes = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    // form-data + fetch cannot guess the boundary via the default headers map,
    // so we must merge getHeaders() (Content-Type: multipart/form-data with a
    // real boundary) or the server sees an empty body.
    headers: { apikey: key, ...form.getHeaders() },
    body: form,
  });
  if (!ocrRes.ok) {
    throw new Error(`OCR.space HTTP ${ocrRes.status}: ${(await ocrRes.text()).slice(0, 200)}`);
  }
  const json = await ocrRes.json();
  if (json.OCRExitCode === 1 && json.ParsedResults?.length > 0) {
    return cleanFields(parseAadhaarFromText(json.ParsedResults[0].ParsedText), allowedKeys);
  }
  throw new Error(`OCR.space error ${json.OCRExitCode}: ${json.ErrorMessage || 'no result'}`);
}

// Reads an Aadhaar card photo. Primary path: Gemini vision (structured,
// reliable). Fallback: OCR.space text + regex heuristics. Returns
// `{ fields, via, errors }` — fields may be empty. `errors` explains why every
// OCR engine failed so the app can show a helpful message (missing API key,
// HTTP status, ...) instead of a generic "could not read".
export async function extractAadhaarFromPhoto(base64, side = 'all') {
  const allowedKeys = keysForSide(side);
  const errors = [];

  try {
    const parsed = await extractWithGemini(base64, buildPrompt(side));
    if (parsed && typeof parsed === 'object') {
      const cleaned = cleanFields(parsed, allowedKeys);
      if (Object.keys(cleaned).length > 0) return { fields: cleaned, via: 'gemini', errors };
    }
  } catch (e) {
    errors.push(`Gemini: ${e.message}`);
  }

  try {
    const cleaned = await extractWithOcrSpace(base64, allowedKeys);
    if (Object.keys(cleaned).length > 0) return { fields: cleaned, via: 'ocr.space', errors };
  } catch (e) {
    errors.push(`OCR.space: ${e.message}`);
  }

  return { fields: {}, via: null, errors };
}