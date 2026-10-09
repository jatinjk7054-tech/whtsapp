import XLSX from 'xlsx';
import db from '../config/db.js';

const keyNorm = (h) => String(h || '').toLowerCase().replace(/[\s_\-./()\[\]']+/g, '');

const normalizePhone = (v) => {
  let s = String(v || '').replace(/\D/g, '');
  if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  return s;
};

const cleanText = (v) => String(v ?? '').trim();

function detectColumns(headers) {
  const detected = { mobile: null, agentName: null, name: null, accountHolder: null, accountNumber: null, ifsc: null, bankName: null, pan: null, aadhaar: null };
  for (const h of headers) {
    const k = keyNorm(h);
    if (!k) continue;
    if (!detected.mobile && /(mobile|phone|contact|whatsapp)/.test(k)) detected.mobile = h;
    else if (!detected.agentName && k.includes('agent') && k.includes('name')) detected.agentName = h;
    else if (!detected.accountHolder && k.includes('holder')) detected.accountHolder = h;
    else if (!detected.accountNumber && k.includes('account') && (k.includes('no') || k.includes('num'))) detected.accountNumber = h;
    else if (!detected.ifsc && k.includes('ifsc')) detected.ifsc = h;
    else if (!detected.bankName && k.includes('bank') && !k.includes('ifsc')) detected.bankName = h;
    else if (!detected.pan && /(^|[^a-z])(pan|pancard|pan[no]{0,1})/i.test(h)) detected.pan = h;
    else if (!detected.aadhaar && /aadhaa?r/.test(k)) detected.aadhaar = h;
    else if (!detected.name && k.includes('name') && !k.includes('holder') && !k.includes('agent')) detected.name = h;
  }
  return detected;
}

function isSkippableRow(row, detected) {
  const name = cleanText(detected.agentName || detected.name ? row[detected.agentName || detected.name] : '');
  const mobile = detected.mobile ? normalizePhone(row[detected.mobile]) : '';
  if (!name && !mobile) return true;
  const lower = name.toLowerCase().trim();
  if (['team', 'team total', 'total', 'grand total', 'branch total', 'all', 'sub total'].includes(lower)) return true;
  return false;
}

export async function inspectBankImport(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: 'File is required' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheets = workbook.SheetNames;
    if (!sheets.length) return res.status(400).json({ message: 'No sheets found in file' });

    const requested = req.body.sheet ? String(req.body.sheet) : '';
    let sheet = sheets.includes(requested) ? requested : '';

    const { data: workers } = await db
      .from('workers')
      .select('id, name, phone, account_holder_name, ifsc_code, account_number, bank_name, pan_number, aadhar_number');

    const byMobile = new Map();
    const byName = new Map();
    const byNameDuplicates = new Set();
    for (const w of workers || []) {
      const m = normalizePhone(w.phone);
      if (m && !byMobile.has(m)) byMobile.set(m, w);
      const n = cleanText(w.name).toLowerCase();
      if (n) {
        if (byName.has(n)) byNameDuplicates.add(n);
        else byName.set(n, w);
      }
    }

    const allMatched = [];
    const allUnmatched = [];
    let detected = {};

    const analyzeSheet = (sheetName) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      if (!rows.length) return { rows: [], matched: [], unmatched: [], detected: {} };
      const cols = detectColumns(Object.keys(rows[0]));
      if (!cols.mobile && !cols.name && !cols.agentName) {
        return { rows, matched: [], unmatched: [], detected: cols };
      }
      const matched = [];
      const unmatched = [];
      rows.forEach((row, idx) => {
        if (isSkippableRow(row, cols)) return;
        const name = cleanText(cols.agentName || cols.name ? row[cols.agentName || cols.name] : '');
        const mobile = cols.mobile ? normalizePhone(row[cols.mobile]) : '';
        const bank = {
          account_holder_name: cols.accountHolder ? cleanText(row[cols.accountHolder]) : '',
          account_number: cols.accountNumber ? cleanText(row[cols.accountNumber]) : '',
          ifsc_code: cols.ifsc ? cleanText(row[cols.ifsc]) : '',
          bank_name: cols.bankName ? cleanText(row[cols.bankName]) : '',
          pan_number: cols.pan ? cleanText(row[cols.pan]) : '',
          aadhar_number: cols.aadhaar ? cleanText(row[cols.aadhaar]) : '',
        };

        let worker = null;
        let matchedBy = null;
        if (mobile) {
          worker = byMobile.get(mobile) || null;
          matchedBy = worker ? 'mobile' : null;
        }
        if (!worker && name) {
          const w = byName.get(name.toLowerCase());
          if (w) {
            worker = w;
            matchedBy = 'name';
          }
        }

        const entry = { row: idx + 2, name, mobile };
        if (worker) {
          matched.push({
            ...entry,
            matched_by: matchedBy,
            worker: {
              id: worker.id,
              name: worker.name,
              phone: worker.phone,
              login_id: worker.login_id,
              account_holder_name: worker.account_holder_name || '',
              account_number: worker.account_number || '',
              ifsc_code: worker.ifsc_code || '',
              bank_name: worker.bank_name || '',
              pan_number: worker.pan_number || '',
              aadhar_number: worker.aadhar_number || '',
            },
            bank: {
              account_holder_name: bank.account_holder_name || worker.account_holder_name || '',
              account_number: bank.account_number || worker.account_number || '',
              ifsc_code: bank.ifsc_code || worker.ifsc_code || '',
              bank_name: bank.bank_name || worker.bank_name || '',
              pan_number: bank.pan_number || worker.pan_number || '',
              aadhar_number: bank.aadhar_number || worker.aadhar_number || '',
            },
          });
        } else {
          unmatched.push(entry);
        }
      });
      return { rows: rows.length, matched, unmatched, detected: cols };
    };

    if (sheet) {
      const result = analyzeSheet(sheet);
      allMatched.push(...result.matched);
      allUnmatched.push(...result.unmatched);
      detected = result.detected;
    } else {
      for (const sheetName of sheets) {
        const result = analyzeSheet(sheetName);
        if (result.rows > 0) {
          sheet = sheetName;
          allMatched.push(...result.matched);
          allUnmatched.push(...result.unmatched);
          detected = result.detected;
          break;
        }
      }
    }

    if (!sheet) return res.json({ sheets, sheet: null, message: 'No data rows found in any sheet', matched: [], unmatched: [], matchedCount: 0, unmatchedCount: 0, totalRows: 0, detected: {} });

    const seen = new Set();
    const matched = allMatched.filter((m) => {
      if (seen.has(m.worker.id)) return false;
      seen.add(m.worker.id);
      return true;
    });

    return res.json({
      sheets,
      sheet,
      detected,
      totalRows: matched.length + allUnmatched.length,
      matchedCount: matched.length,
      unmatchedCount: allUnmatched.length,
      matched,
      unmatched: allUnmatched,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function saveBankDetails(req, res) {
  try {
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ message: 'No updates provided' });

    const results = [];
    let success = 0;

    const BATCH = 50;
    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH);
      const batchResults = await Promise.all(chunk.map(async (u) => {
        const workerId = u.worker_id;
        if (!workerId) {
          return { worker_id: null, name: u.name || '', status: 'failed', error: 'Missing worker_id' };
        }
        const payload = {};
        if (u.account_holder_name !== undefined) payload.account_holder_name = cleanText(u.account_holder_name) || null;
        if (u.account_number !== undefined) payload.account_number = cleanText(u.account_number) || null;
        if (u.ifsc_code !== undefined) payload.ifsc_code = cleanText(u.ifsc_code) || null;
        if (u.bank_name !== undefined) payload.bank_name = cleanText(u.bank_name) || null;
        if (u.pan_number !== undefined) payload.pan_number = cleanText(u.pan_number) || null;
        if (u.aadhar_number !== undefined) payload.aadhar_number = cleanText(u.aadhar_number) || null;
        if (u.phone !== undefined) payload.phone = cleanText(u.phone) || null;
        payload.updated_at = new Date().toISOString();

        try {
          const { data, error } = await db
            .from('workers')
            .update(payload)
            .eq('id', workerId)
            .select('id, name')
            .single();
          if (error) throw error;
          success++;
          return { worker_id: workerId, name: u.name || data?.name || '', status: 'success' };
        } catch (err) {
          return { worker_id: workerId, name: u.name || '', status: 'failed', error: err.message };
        }
      }));
      results.push(...batchResults);
    }

    return res.json({
      total: updates.length,
      success,
      failed: updates.length - success,
      results,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
