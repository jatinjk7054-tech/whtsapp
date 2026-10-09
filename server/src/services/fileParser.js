import XLSX from 'xlsx';

export function parseUploadedFile(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheets found in file');
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return json;
}

export function normalizeHeaders(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    const k = key.toString().toLowerCase().replace(/[\s_\-./]+/g, '').trim();
    normalized[k] = value;
  }
  return normalized;
}

const COLUMN_MAP = {
  transactiondate: 'transaction_date',
  date: 'transaction_date',
  bankdonarname: 'bank_donor_name',
  'bankdonor': 'bank_donor_name',
  agentdonarname: 'agent_donor_name',
  agentname: 'agent_name',
  mobileno: 'mobile_number',
  mobile: 'mobile_number',
  mob: 'mobile_number',
  moblie: 'mobile_number',
  mobilenumber: 'mobile_number',
  'mobileno': 'mobile_number',
  'mobile no': 'mobile_number',
  'mobile no.': 'mobile_number',
  'mobile number': 'mobile_number',
  phone: 'mobile_number',
  'mobileno2tel': 'mobile_2',
  'mobile2': 'mobile_2',
  'alternatephone': 'mobile_2',
  len: null,
  count: null,
  address1: 'address_1',
  'address1': 'address_1',
  address2: 'address_2',
  'address2': 'address_2',
  station: 'station',
  eastwest: null,
  city: 'city',
  pincode: 'pin_code',
  pin: 'pin_code',
  panno: 'pan_number',
  pan: 'pan_number',
  'panno': 'pan_number',
  mailid: 'email',
  email: 'email',
  birthdate: 'birth_date',
  dob: 'birth_date',
  datacategory: 'category',
  category: 'category',
  data_category: 'category',
  data: 'category',
  ngocode: 'ngo',
  ngo: 'ngo',
  team: 'team',
  fsename: null,
  mop: 'mop',
  receivedbank: 'received_bank',
  paymentidno: 'payment_id_no',
  paymentid: 'payment_id_no',
  donorsbankname: 'donors_bank_name',
  amount: 'amount',
  amt: 'amount',
  dummyamount: 'amount',
  'dummy amount': 'amount',
  receiptno: 'receipt_no',
  receiptbookno: null,
  receiptdate: 'receipt_date',
  time: 'receipt_time',
  projectsupported: 'project_supported',
  accountof: 'account_of',
  remark1: null,
  branch: 'branch',
  branchname: 'branch',
  name: 'name',
  'donorname': 'bank_donor_name',
  fullname: 'name',
  'firstname': 'name',
  surname: null,
  whatsupandroidno: 'whatsapp_no',
  'whatsapp': 'whatsapp_no',
  'whatsappno': 'whatsapp_no',
  froname: 'fro_name',
  fro: 'fro_name',
  assignee: 'fro_name',
  assigneename: 'fro_name',
  fro_worker: 'fro_name',
}

function buildColumnMap(headers) {
  const map = {};
  const fieldsUsed = {};
  for (let i = 0; i < headers.length; i++) {
    const key = (headers[i]?.toString() || '').toLowerCase().replace(/[\s_\-./]+/g, '').trim();
    let field = COLUMN_MAP[key] || null;
    if (field) {
      if (fieldsUsed[field] !== undefined && field !== 'station') {
        field = null;
      } else {
        fieldsUsed[field] = i;
      }
    }
    map[i] = field;
  }
  return map;
}

export function getSheetNames(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return workbook.SheetNames;
}

export function parseImportFile(buffer, options = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetNames = options.sheets
    ? workbook.SheetNames.filter(s => options.sheets.includes(s))
    : workbook.SheetNames;

  if (sheetNames.length === 0) return { rows: [], fullSheet: false };

  const firstArrays = XLSX.utils.sheet_to_json(workbook.Sheets[sheetNames[0]], { header: 1, defval: '' });
  const isFull = firstArrays.length >= 2 && isFullSheetArray(firstArrays[0]);

  const allRows = [];

  for (const sheetName of sheetNames) {
    if (isFull) {
      const arrays = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
      if (arrays.length < 2) continue;

      const headers = arrays[0];
      const columnMap = buildColumnMap(headers);
      const dataRows = arrays.slice(1);

      for (const row of dataRows) {
        const obj = {};
        for (let i = 0; i < row.length; i++) {
          const field = columnMap[i];
          if (field) {
            obj[field] = row[i];
          }
        }
        if (obj.mobile_number) {
          if (!obj.name) obj.name = obj.bank_donor_name || null;
          if (!obj.category) obj.category = obj.data_category || '';
          obj.amount = parseFloat(obj.amount) || 0;
          obj.ngo = sheetName;
          allRows.push(obj);
        }
      }
    } else {
      const objects = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      for (const row of objects) {
        const norm = normalizeHeaders(row);
        const data = extractQuickRowData(norm);
        if (data) {
          data.ngo = sheetName;
          allRows.push(data);
        }
      }
    }
  }

  return { rows: allRows, fullSheet: isFull };
}

function isFullSheetArray(headers) {
  const norms = headers.map(h => (h?.toString() || '').toLowerCase().replace(/[\s_\-./]+/g, '').trim());
  const indicators = ['panno', 'address1', 'city', 'mailid', 'birthdate', 'pan', 'address'];
  let hits = 0;
  for (const key of norms) {
    if (indicators.includes(key) || key.includes('pan') || key.includes('address') || key.includes('birth') || key.includes('mail')) {
      hits++;
    }
  }
  return hits >= 3;
}

function mapValue(val) {
  if (val === undefined || val === null || val === '') return null;
  const s = String(val).trim();
  return s || null;
}

export function extractFullRowData(normalized) {
  const mapped = {};
  let hasData = false;

  for (const [key, value] of Object.entries(normalized)) {
    const field = COLUMN_MAP[key];
    if (field && !mapped[field]) {
      mapped[field] = mapValue(value);
      if (field === 'mobile_number') hasData = true;
    }
  }

  if (!mapped.name) {
    mapped.name = mapped.bank_donor_name || null;
  }

  if (!mapped.category) {
    mapped.category = mapped.data_category || '';
  }

  mapped.amount = parseFloat(mapped.amount) || 0;

  if (!hasData || !mapped.mobile_number) return null;
  return mapped;
}

export function extractQuickRowData(normalized) {
  const name = normalized.name || normalized['fullname'] || normalized['full name'] || normalized.donorname || normalized['donor name'] || '';
  const mobile = normalized.mobilenumber || normalized['mobilenumber'] || normalized.mobile || normalized.mob || normalized.moblie || normalized.phone || normalized['mobile number'] || normalized['phone number'] || normalized.mobileno || normalized['mobile no'] || normalized['mobile no.'] || '';
  const category = normalized.category || normalized['datacategory'] || normalized['data category'] || normalized.ngocode || normalized['ngo code'] || normalized.ngoshortname || normalized['ngo short name'] || normalized.data || '';
  const rawAmount = (normalized.amount || normalized.amt || normalized['dummyamount'] || normalized['dummy amount'] || '0').toString().replace(/,/g, '');
  const amount = parseFloat(rawAmount) || 0;

  if (!name || !mobile) return null;

  return {
    name: String(name).trim(),
    mobile_number: String(mobile).trim(),
    category: String(category).trim(),
    amount,
  };
}

export function isFullSheet(rows) {
  if (rows.length === 0) return false;
  const sample = normalizeHeaders(rows[0]);
  const fullIndicators = ['panno', 'address1', 'city', 'mailid', 'birthdate', 'pan', 'address'];
  let hits = 0;
  for (const key of Object.keys(sample)) {
    if (fullIndicators.includes(key) || key.includes('pan') || key.includes('address') || key.includes('birth') || key.includes('mail')) {
      hits++;
    }
  }
  return hits >= 3;
}

export function normalizeDate(val) {
  if (!val || val === 'NA' || val === 'na') return null;
  const s = String(val).trim();

  // Excel serial date number
  if (/^\d+$/.test(s) && s.length <= 5) {
    const d = new Date(1900, 0, parseInt(s) - 1);
    return d.toISOString().split('T')[0];
  }

  // YYYY-MM-DD (already valid ISO)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD-MM-YYYY (hyphen-separated, e.g. "16-04-1965")
  const hyphenMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (hyphenMatch) {
    const [, d, m, y] = hyphenMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD.MM.YYYY (dot-separated, e.g. "13.12.1992")
  const dotMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const [, d, m, y] = dotMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD/MM/YYYY (slash-separated, e.g. "13/12/1992")
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

export function dedupRows(rows) {
  const groups = {};
  for (const row of rows) {
    const key = row.mobile_number;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(row);
  }

  const deduped = [];
  let duplicatesRemoved = 0;

  for (const [mobile, group] of Object.entries(groups)) {
    group.sort((a, b) => b.amount - a.amount);
    deduped.push(group[0]);
    duplicatesRemoved += group.length - 1;
  }

  return { deduped, duplicatesRemoved };
}
