import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XLSX = require('xlsx');

dotenv({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL || 'https://api.beingsevak.org/api';
const OUT = process.env.OUT_XLSX || 'C:\\Users\\ADMIN\\Desktop\\missing_receipt_numbers.xlsx';
const PAGE_LIMIT = 100;
const CONCURRENCY = 20;

const NGOS = ['bsct', 'aflf', 'mann'];
const NGO_LABELS = { bsct: 'BSCT', aflf: 'AFLF', mann: 'MANN' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const postLogin = async () => {
  const res = await fetch(`${API_BASE}/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('Login returned no token');
  return data.token;
};

const fetchPage = async (token, page, retries = 4) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(
        `${API_BASE}/accounts/receipts?page=${page}&limit=${PAGE_LIMIT}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.status === 429) {
        await sleep(1000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(800 * attempt);
    }
  }
};

const lastNumericGroup = (s) => {
  const m = String(s).match(/\d+/g);
  return m ? parseInt(m[m.length - 1], 10) : null;
};

const run = async () => {
  const token = await postLogin();
  console.log('Logged in.');

  const first = await fetchPage(token, 1);
  const total = first.total;
  const pages = Math.ceil(total / PAGE_LIMIT);
  console.log(`Total receipts: ${total} | pages: ${pages}`);

  const byNgo = { bsct: new Set(), aflf: new Set(), mann: new Set() };
  const nullNoCount = { bsct: 0, aflf: 0, mann: 0 };

  let queue = [];
  for (let p = 2; p <= pages; p++) queue.push(p);
  let nextIdx = 0;
  let doneCount = 1;
  let lastLog = Date.now();

  const worker = async () => {
    while (true) {
      const p = nextIdx++;
      if (p > pages) break;
      const resp = await fetchPage(token, p);
      for (const r of resp.data) {
        const set = byNgo[r.project_id];
        if (!set) continue;
        const n = lastNumericGroup(r.receipt_no);
        if (n == null) {
          nullNoCount[r.project_id] += 1;
        } else {
          set.add(n);
        }
      }
      doneCount++;
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        console.log(`fetched ${doneCount}/${pages} pages`);
      }
    }
  };

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  const wb = XLSX.utils.book_new();
  const summaryRows = [];
  const maxLen = Math.max(
    ...NGOS.map((ngo) => {
      const nums = byNgo[ngo];
      const max = Math.max(0, ...nums);
      const missing = [];
      for (let i = 1; i <= max; i++) if (!nums.has(i)) missing.push(i);
      summaryRows.push({ ngo, max, present: nums.size, missing: missing.length, nullNo: nullNoCount[ngo] });
      return missing.length;
    })
  );

  const cols = NGOS.map((ngo) => {
    const nums = byNgo[ngo];
    const max = Math.max(0, ...nums);
    const missing = [];
    for (let i = 1; i <= max; i++) if (!nums.has(i)) missing.push(i);
    return missing;
  });

  const rows = [];
  rows.push(NGOS.map((ngo) => NGO_LABELS[ngo]));
  for (let i = 0; i < maxLen; i++) {
    rows.push(cols.map((c) => (i < c.length ? c[i] : null)));
  }
  rows.push([]);
  rows.push(['SUMMARY', '', '']);
  rows.push(['NGO', 'Max number', 'Present', 'Missing', 'No receipt_no']);
  for (const s of summaryRows) {
    rows.push([NGO_LABELS[s.ngo], s.max, s.present, s.missing, s.nullNo]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Missing');

  XLSX.writeFile(wb, OUT);
  for (const s of summaryRows) {
    console.log(`${s.ngo}: max ${s.max}, present ${s.present}, missing ${s.missing}, null receipt_no ${s.nullNo}`);
  }
  console.log('->', OUT);
};

run().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
