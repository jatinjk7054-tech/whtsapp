import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4';
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

const HEADERS = ['Candidate', 'Role', 'Age', 'Score', 'Percentage', 'Verdict', 'Date', 'Time', 'Pass/Fail', 'AI Feedback'];
const DATE_IDX = HEADERS.indexOf('Date');
const TIME_IDX = HEADERS.indexOf('Time');

const DAY_SEP_PREFIX = '— ';
const PASS_FILL = { red: 0.776, green: 0.937, blue: 0.808 };
const PASS_TEXT = { red: 0, green: 0.38, blue: 0 };
const FAIL_FILL = { red: 1, green: 0.78, blue: 0.78 };
const FAIL_TEXT = { red: 0.61, green: 0, blue: 0 };
const HEADER_FILL = { red: 0.29, green: 0.4, blue: 0.25 };
const HEADER_TEXT = { red: 1, green: 1, blue: 1 };
const GRAY_FILL = { red: 0.87, green: 0.88, blue: 0.89 };
const GRAY_TEXT = { red: 0.25, green: 0.27, blue: 0.3 };

let cachedToken = null;
let cachedExpiry = 0;
let headersReady = false;
let setupDone = false;
let sheetId = null;
let sheetRowCount = 1000;
let writeQueue = Promise.resolve();

function getCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  const trimmed = raw.trim();

  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) return JSON.parse(decoded);
  } catch {
    // not base64, fall through to file path
  }

  const resolved = path.isAbsolute(trimmed) ? trimmed : path.join(process.cwd(), trimmed);
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
}

async function getAccessToken(creds) {
  if (cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: creds.client_email,
      scope: SCOPES.join(' '),
      aud: creds.token_uri || TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    creds.private_key,
    { algorithm: 'RS256' },
  );
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Google OAuth failed: ' + (data.error_description || res.statusText));
  }
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function api(pathname, options) {
  const sheet = process.env.GOOGLE_SHEET_ID;
  const creds = getCreds();
  if (!sheet || !creds) throw new Error('Google Sheets not configured (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT)');
  const token = await getAccessToken(creds);
  const res = await fetch(`${SHEETS_API}/spreadsheets/${sheet}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Sheets API error: ' + (data.error?.message || res.statusText));
  return data;
}

async function getSheetId() {
  if (sheetId != null) return sheetId;
  const data = await api('?fields=sheets.properties', { method: 'GET' });
  const sheet =
    data.sheets?.find((s) => s.properties?.title === SHEET_NAME) || data.sheets?.[0];
  if (!sheet?.properties || sheet.properties.sheetId == null) throw new Error('Could not find sheet tab');
  sheetId = sheet.properties.sheetId;
  sheetRowCount = sheet.properties.gridProperties?.rowCount || 1000;
  return sheetId;
}

async function batchUpdate(requests) {
  return api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests }) });
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function ensureHeaders() {
  if (headersReady) return;
  const lastCol = colLetter(HEADERS.length);
  const data = await api(`/values/${SHEET_NAME}!A1:${lastCol}1`, { method: 'GET' });
  const row = data.values?.[0] || [];
  const same = row.length === HEADERS.length && HEADERS.every((h, i) => row[i] === h);
  if (!same) {
    await api(`/values/${SHEET_NAME}!A1:${lastCol}1?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ majorDimension: 'ROWS', values: [HEADERS] }),
    });
  }
  headersReady = true;
}

async function setupFormatting() {
  if (setupDone) return;
  const id = await getSheetId();
  const numCols = HEADERS.length;
  const requests = [
    {
      updateSheetProperties: {
        properties: { sheetId: id, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId: id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
        cell: {
          userEnteredFormat: {
            backgroundColor: HEADER_FILL,
            textFormat: { foregroundColor: HEADER_TEXT, bold: true, fontSize: 11 },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: id, startRowIndex: 1, startColumnIndex: numCols - 1, endColumnIndex: numCols }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'PASS' }] },
            format: {
              backgroundColor: PASS_FILL,
              textFormat: { foregroundColor: PASS_TEXT, bold: true },
            },
          },
        },
        index: 0,
      },
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: id, startRowIndex: 1, startColumnIndex: numCols - 1, endColumnIndex: numCols }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'FAIL' }] },
            format: {
              backgroundColor: FAIL_FILL,
              textFormat: { foregroundColor: FAIL_TEXT, bold: true },
            },
          },
        },
        index: 1,
      },
    },
  ];
  await batchUpdate(requests);
  setupDone = true;
}

function isValidRow(r) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(r[DATE_IDX] || '')) &&
    /^\d{2}:\d{2}:\d{2}$/.test(String(r[TIME_IDX] || ''));
}

function sortKey(r) {
  return `${String(r[DATE_IDX] || '')} ${String(r[TIME_IDX] || '')}`;
}

function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const weekday = new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'short' });
  const month = new Date(y, m - 1, d).toLocaleDateString('en-IN', { month: 'short' });
  return `${DAY_SEP_PREFIX}${weekday} ${d} ${month} ${y} —`;
}

async function readRows() {
  const lastCol = colLetter(HEADERS.length);
  const range = `${SHEET_NAME}!A2:${lastCol}${sheetRowCount}`;
  const data = await api(`/values/${encodeURIComponent(range)}`, { method: 'GET' });
  return (data.values || []).filter((r) => r.some((c) => String(c).trim() !== ''));
}

function buildOutput(rows) {
  const pad = (r) => {
    const row = r.slice(0, HEADERS.length);
    while (row.length < HEADERS.length) row.push('');
    return row;
  };
  const data = rows
    .filter((r) => !String(r[0] || '').startsWith(DAY_SEP_PREFIX))
    .filter((r) => isValidRow(r))
    .map(pad)
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  const out = [];
  let currentDay = null;
  for (const r of data) {
    const dk = String(r[DATE_IDX] || '');
    if (dk && dk !== currentDay) {
      currentDay = dk;
      out.push(pad([dayLabel(dk)]));
    }
    out.push(r);
  }
  return out;
}

async function rebuildSheet(rows) {
  const id = await getSheetId();
  const numCols = HEADERS.length;
  const out = buildOutput(rows);
  await batchUpdate([
    {
      updateCells: {
        range: { sheetId: id, startRowIndex: 1, endRowIndex: sheetRowCount, startColumnIndex: 0, endColumnIndex: numCols },
        fields: 'userEnteredValue,userEnteredFormat',
      },
    },
  ]);
  if (out.length > 0) {
    await api(
      `/values/${SHEET_NAME}!A2:${colLetter(numCols)}${1 + out.length}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ majorDimension: 'ROWS', values: out }) },
    );
  }
  const grayRequests = [];
  out.forEach((r, i) => {
    if (String(r[0] || '').startsWith(DAY_SEP_PREFIX)) {
      const rowIdx = i + 2;
      grayRequests.push({
        repeatCell: {
          range: { sheetId: id, startRowIndex: rowIdx - 1, endRowIndex: rowIdx, startColumnIndex: 0, endColumnIndex: numCols },
          cell: {
            userEnteredFormat: {
              backgroundColor: GRAY_FILL,
              textFormat: { foregroundColor: GRAY_TEXT, bold: true },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    }
  });
  if (grayRequests.length > 0) await batchUpdate(grayRequests);
}

// Append one candidate result row. Best-effort: throws on failure so callers can log it.
export async function appendQuizResult(row) {
  await ensureHeaders();
  await setupFormatting();
  const values = HEADERS.map((h) => row[h] ?? '');
  const run = writeQueue.then(async () => {
    const existing = await readRows();
    existing.push(values);
    await rebuildSheet(existing);
  });
  writeQueue = run.catch(() => {});
  return run;
}
