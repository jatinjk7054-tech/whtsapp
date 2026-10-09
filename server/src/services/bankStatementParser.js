import XLSX from 'xlsx';

const BANK_PATTERNS = [
  {
    name: 'Axis Bank',
    keywords: ['axis'],
    columns: {
      date: /date|txn\s*date|transaction\s*date|value\s*date/i,
      description: /narration|description|particulars|details/i,
      ref_no: /chq|cheque|ref|reference\s*(no|number)|transaction\s*ref/i,
      debit: /debit|withdrawal|withdrawl|dr\b|debit\s*amt/i,
      credit: /credit|deposit|cr\b|credit\s*amt/i,
      balance: /balance|closing\s*balance/i,
    },
  },
  {
    name: 'HDFC Bank',
    keywords: ['hdfc'],
    columns: {
      date: /date|txn\s*date|transaction\s*date|value\s*date/i,
      description: /narration|description|particulars|details/i,
      ref_no: /chq|cheque|ref|chq\/ref/i,
      debit: /withdrawal\s*amt|debit|dr\b/i,
      credit: /deposit\s*amt|credit|cr\b/i,
      balance: /closing\s*balance|balance/i,
    },
  },
  {
    name: 'SBI',
    keywords: ['sbi', 'state bank'],
    columns: {
      date: /txn\s*date|transaction\s*date|date|value\s*date/i,
      description: /description|narration|particulars/i,
      ref_no: /ref\s*no|ref\/cheque|cheque\s*no|chq/i,
      debit: /debit|dr\b|withdrawal/i,
      credit: /credit|cr\b|deposit/i,
      balance: /balance/i,
    },
  },
  {
    name: 'ICICI Bank',
    keywords: ['icici'],
    columns: {
      date: /date|txn\s*date|transaction\s*date|value\s*date/i,
      description: /description|narration|particulars|details/i,
      ref_no: /chq|cheque|ref|chq\/ref/i,
      debit: /withdrawal|debit|dr\b/i,
      credit: /deposit|credit|cr\b/i,
      balance: /balance|closing\s*balance/i,
    },
  },
  {
    name: 'Generic',
    keywords: [],
    columns: {
      date: /date|txn\s*date|transaction\s*date|posted\s*date|value\s*date/i,
      description: /description|narration|particulars|details|memo|remark|notes|transaction/i,
      ref_no: /ref|reference|chq|cheque|id|number|transaction\s*id/i,
      debit: /debit|withdrawal|withdrawl|dr\b|amount.*out|paid|payment/i,
      credit: /credit|deposit|cr\b|amount.*in|received|deposit/i,
      balance: /balance|available|running\s*balance/i,
    },
  },
];

function detectBankFormat(headers) {
  const headerSet = new Set(headers.map(h => h.toLowerCase().trim()));
  const headerStr = headers.join(' ').toLowerCase();

  for (const bank of BANK_PATTERNS) {
    if (bank.keywords.length > 0 && !bank.keywords.some(k => headerStr.includes(k))) continue;
    const matched = [];
    for (const [field, pattern] of Object.entries(bank.columns)) {
      const col = headers.find(h => pattern.test(h));
      if (col) matched.push(field);
    }
    if (matched.length >= 3) return bank;
  }

  return BANK_PATTERNS[BANK_PATTERNS.length - 1];
}

function mapColumns(headers, bankFormat) {
  const mapping = {};
  for (const [field, pattern] of Object.entries(bankFormat.columns)) {
    const col = headers.find(h => pattern.test(h));
    if (col) mapping[field] = col;
  }
  return mapping;
}

function parseAmount(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return Math.abs(val);
  const cleaned = String(val).replace(/[,]/g, '').replace(/[\u20B9Rs.\s]/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : Math.abs(num);
}

function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    try {
      const d = XLSX.SSF.parse_date_code(val);
      if (d) {
        const y = d.y, m = String(d.m).padStart(2, '0'), day = String(d.d).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    } catch {}
    return null;
  }
  const cleaned = String(val).trim();
  const patterns = [
    /(\d{2})\/(\d{2})\/(\d{4})/,
    /(\d{2})-(\d{2})-(\d{4})/,
    /(\d{4})-(\d{2})-(\d{2})/,
    /(\d{2})\/(\d{2})\/(\d{2})/,
    /(\d{2})-(\d{2})-(\d{2})/,
  ];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (!m) continue;
    let d, mo, y;
    if (p.source.includes('(\\d{4})-(\\d{2})-(\\d{2})')) {
      y = m[1]; mo = m[2]; d = m[3];
    } else if (p.source.includes('(\\d{2})/(\\d{2})/(\\d{4})') || p.source.includes('(\\d{2})-(\\d{2})-(\\d{4})')) {
      d = m[1]; mo = m[2]; y = m[3];
    } else {
      d = m[1]; mo = m[2]; y = '20' + m[3];
    }
    if (parseInt(mo) > 12) { [d, mo] = [mo, d]; }
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  try {
    const dt = new Date(cleaned);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  } catch {}
  return null;
}

export function parseBankStatement(fileBuffer, fileName, explicitSourceName) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');
  const sheet = workbook.Sheets[sheetName];
  const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  if (!rawData || rawData.length < 2) throw new Error('File is empty or has insufficient data');

  const headerRowIndex = rawData.findIndex(row =>
    row && row.some(cell => cell && BANK_PATTERNS.some(bank =>
      Object.values(bank.columns).some(pat => pat.test(String(cell)))
    ))
  );

  if (headerRowIndex === -1) throw new Error('Could not detect bank statement format. Ensure the file contains headers like: Date, Description, Debit, Credit, Balance');

  const headers = rawData[headerRowIndex].map(h => String(h || '').trim());
  const dataRows = rawData.slice(headerRowIndex + 1).filter(row => row && row.some(cell => cell != null && cell !== ''));

  const bankFormat = detectBankFormat(headers);
  const mapping = mapColumns(headers, bankFormat);

  const sourceName = explicitSourceName || bankFormat.name;

  const parsed = [];
  const errors = [];

  for (let i = 0; i < dataRows.length; i++) {
    try {
      const row = dataRows[i];
      const get = (field) => {
        const colName = mapping[field];
        if (!colName) return null;
        const idx = headers.indexOf(colName);
        return idx >= 0 ? row[idx] : null;
      };

      const dateRaw = get('date');
      const date = parseDate(dateRaw);
      if (!date) continue;

      const description = String(get('description') || '').trim() || null;
      const refNo = String(get('ref_no') || '').trim() || null;

      const debitRaw = get('debit');
      const creditRaw = get('credit');
      const debit = parseAmount(debitRaw);
      const credit = parseAmount(creditRaw);
      const amount = debit || credit || 0;
      const isDebit = debit != null && (credit == null || debit > 0);
      const balance = parseAmount(get('balance'));

      if (amount === 0 && description == null && refNo == null) continue;

      parsed.push({
        row: i + 1,
        date,
        description: description || '',
        ref_no: refNo || '',
        debit: debit || 0,
        credit: credit || 0,
        amount,
        is_debit: !!isDebit,
        balance,
        source_name: sourceName,
      });
    } catch (err) {
      errors.push({ row: i + headerRowIndex + 2, error: err.message });
    }
  }

  return {
    bank: bankFormat.name,
    source_name: sourceName,
    total_rows: dataRows.length,
    parsed_rows: parsed.length,
    error_rows: errors.length,
    errors,
    rows: parsed,
  };
}
