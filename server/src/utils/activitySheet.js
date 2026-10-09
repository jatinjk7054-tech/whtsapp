import XLSX from 'xlsx';

// Sheet label -> canonical sector name. Keys repeat the aliases seen in the
// user's activity sheets so imports land in the right sector row.
const SECTOR_NAME_MAP = {
  'Education & Learning': 'Education & Learning',
  'Livelihood, Skill & Employment Aatmanirbhar': 'Livelihood, Skill & Employment Aatmanirbhar',
  'Livelihood, Skill & Employment Aatmanirbhar Sector': 'Livelihood, Skill & Employment Aatmanirbhar',
  'Livelihood': 'Livelihood, Skill & Employment Aatmanirbhar',
  'Livelihood & Skill Development': 'Livelihood, Skill & Employment Aatmanirbhar',
  'Technology & Assistive Devices': 'Technology & Assistive Devices',
  'Independent Living & Mobility': 'Independent Living & Mobility',
  'Health, Rehabilitation & Wellness': 'Health, Rehabilitation & Wellness',
  'Sports, Culture & Talent': 'Sports, Culture & Talent',
  'Women & Children with Disabilities': 'Women & Children with Disabilities',
  'Rights, Government Schemes & Accessibility': 'Rights, Government Schemes & Accessibility',
  'Products, Entrepreneurship & E-commerce': 'Products, Entrepreneurship & E-commerce',
  'Social Inclusion & Community': 'Social Inclusion & Community',
  'Environment': 'Environment',
  'Environment Sector': 'Environment',
  'Nutrition': 'Nutrition',
  'Nutrition Sector': 'Nutrition',
  'LIVELIHOOD & SKILL DEVELOPMENT': 'Livelihood, Skill & Employment Aatmanirbhar',
  'ASSISTIVE DEVICES': 'Technology & Assistive Devices',
  'HEALTH & WELFARE': 'Health, Rehabilitation & Wellness',
  'COMMUNITY INCLUSION': 'Social Inclusion & Community',
  'ENVIRONMENT': 'Environment',
};

// Branded campaign / event names are NOT master activities (the "No. of
// Activities" counts reference the generic catalog). Imports skip them and
// report them separately so nothing disappears silently.
const CAMPAIGN_NAMES = new Set([
  'Braille Book Distribution',
  'Digital Education Centre',
  'Computer Education with Screen Readers',
  'AI & Smart Assistive Technology Training',
  'Spoken English Classes',
  'Competitive Exam Coaching',
  'Digital Skill Development',
  'Library & Audio Book Centre',
  'Scholarship & Education Fee Support',
  'School Bag & Stationery Distribution for Blind Students',
  'Sewing Machine Distribution',
  'Flour Mill Distribution',
  'Rozgaar Booth',
  'Vocational Training',
  'Digital Employment Support',
  'Interview Preparation Sessions',
  'Entrepreneurship Training',
  'White Cane Distribution',
  'Smart Glass Distribution',
  'Talking Devices',
  'Accessible Mobile Phones',
  'Braille Slates & Learning Kits',
  'Medical Emergency Support',
  'Eye Care & Rehabilitation',
  'Nutrition Support',
  'Ration Kits',
  'Annapurna Food Distribution',
  'Seasonal Relief Kits',
  'Metro Saheli',
  'Volunteer Reading Programme',
  'Awareness Programmes',
  'Disability Rights Campaigns',
  'Bottle Crusher Machines',
  'Plantation Drives',
  'Animal Feeding',
  'Rainwater Harvesting Projects',
]);

export function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isCampaignName(name) {
  return CAMPAIGN_NAMES.has(name);
}

// Normalize any sheet label to the DB sector name. DB-driven: pass the list
// of actual sector names so the mapping always matches the live rows.
export function canonicalizeSector(label, sectorNames) {
  const raw = String(label || '').replace(/^\s*\d+[\.\)\-]?\s*/, '').trim().replace(/\s+/g, ' ');
  if (!raw) return raw;
  if (SECTOR_NAME_MAP[raw]) return SECTOR_NAME_MAP[raw];
  const sectorSet = new Set(sectorNames.map(n => String(n)));
  if (sectorSet.has(raw)) return String(raw);

  const stripped = raw.replace(/\s+Sector$/i, '');
  if (SECTOR_NAME_MAP[stripped] || sectorSet.has(stripped)) return SECTOR_NAME_MAP[stripped] || stripped;

  const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = normKey(stripped);
  const exact = sectorNames.find(n => normKey(n) === key);
  if (exact) return String(exact);

  if (key.includes('livelihood') || key.includes('aatmanirbhar') || key.includes('skill') || key.includes('employment')) return 'Livelihood, Skill & Employment Aatmanirbhar';
  if (key.includes('education') || key.includes('learn')) return 'Education & Learning';
  if (key.includes('technology') || key.includes('assistive') || key.includes('device')) return 'Technology & Assistive Devices';
  if (key.includes('independent') || key.includes('mobility') || key.includes('living')) return 'Independent Living & Mobility';
  if (key.includes('health') || key.includes('rehabilitation') || key.includes('wellness') || key.includes('welfare')) return 'Health, Rehabilitation & Wellness';
  if (key.includes('sport') || key.includes('culture') || key.includes('talent')) return 'Sports, Culture & Talent';
  if (key.includes('women') || key.includes('child') || key.includes('children')) return 'Women & Children with Disabilities';
  if (key.includes('right') || key.includes('government') || key.includes('accessib') || key.includes('scheme')) return 'Rights, Government Schemes & Accessibility';
  if (key.includes('product') || key.includes('entrepreneurship') || key.includes('ecommerce') || key.includes('e-commerce') || key.includes('market')) return 'Products, Entrepreneurship & E-commerce';
  if (key.includes('social') || key.includes('inclusion') || key.includes('community')) return 'Social Inclusion & Community';
  if (key.includes('environment')) return 'Environment';
  if (key.includes('nutrition') || key.includes('food')) return 'Nutrition';
  return String(raw);
}

// Parse the first worksheet of an uploaded Excel/CSV file into sector+activity
// rows. Tolerates header variants ("Sector", "Sector No", "Activity or
// Project", "Activities", ...) and carries the sector forward when cells are
// merged/blank (common in the user's sheets).
export function parseActivitySheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

  const isSectorHeader = (h) => /^sector/.test(h) && !/\bno\b|number|count/i.test(h);
  const isNameHeader = (h) => /activity|project/.test(h) && !/\bno\b|number|count|type/i.test(h) && !/^\s*no\b/i.test(h);
  const isNgoHeader = (h) => /^ngo/.test(h) && !/activity/.test(h);

  let sectorCol = -1;
  let nameCol = -1;
  let ngoCol = -1;
  let headerRow = -1;
  for (let r = 0; r < Math.min(aoa.length, 30); r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!cell) continue;
      if (sectorCol === -1 && isSectorHeader(cell)) sectorCol = c;
      if (nameCol === -1 && isNameHeader(cell)) nameCol = c;
      if (ngoCol === -1 && isNgoHeader(cell)) ngoCol = c;
    }
    if (sectorCol !== -1 && nameCol !== -1) { headerRow = r; break; }
  }

  if (sectorCol === -1 || nameCol === -1 || headerRow === -1) {
    throw new Error('Could not find "Sector" and "Activity" columns in the uploaded sheet');
  }

  const rows = [];
  let lastSector = '';
  let lastNgo = '';
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const sectorCell = String(row[sectorCol] ?? '').replace(/\s+/g, ' ').trim();
    const nameCell = String(row[nameCol] ?? '').replace(/\s+/g, ' ').trim();
    const ngoCell = ngoCol !== -1 ? String(row[ngoCol] ?? '').replace(/\s+/g, ' ').trim() : '';
    if (sectorCell) lastSector = sectorCell;
    if (ngoCell) lastNgo = ngoCell;
    if (!nameCell) continue;
    if (/^(total|grand\s+total|sub\s+total)/i.test(nameCell)) continue;
    if (!lastSector) continue;
    rows.push({ sectorLabel: lastSector, name: nameCell, ngoLabel: lastNgo || null });
  }

  return { rows, sheetName, hasNgoColumn: ngoCol !== -1 };
}

// ─── Events sheet ───────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Excel date serial (days since 1899-12-30) or common string → ISO yyyy-mm-dd.
export function excelDateToISO(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : toYmd(d);
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    let [, a, b, yr] = m;
    if (yr.length === 2) yr = '20' + yr;
    if (yr.length !== 4) return null;
    const da = Number(a), db = Number(b);
    if (da > 12 && db <= 31 && db > 0) return `${yr}-${pad2(db)}-${pad2(da)}`;
    if (db > 12 && da <= 31 && da > 0) return `${yr}-${pad2(da)}-${pad2(db)}`;
    return `${yr}-${pad2(db)}-${pad2(da)}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : toYmd(d);
}

// Time value (Excel fraction, "10:00", "10:00 AM") → "HH:MM". Returns null if unusable.
export function excelTimeToHM(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const mins = Math.round(value * 24 * 60);
    return `${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (/pm|PM|p\.m\./.test(s) && h < 12) h += 12;
    if (/am|AM|a\.m\./.test(s) && h === 12) h = 0;
    return `${pad2(h)}:${pad2(min)}`;
  }
  m = s.match(/^(\d{1,2})([.:]?)(\d{0,2})\s*(am|pm|AM|PM)?/);
  if (m && m[1]) {
    let h = Number(m[1]);
    const min = m[3] ? Number(m[3]) : 0;
    if (/pm/i.test(m[4] || '') && h < 12) h += 12;
    if (/am/i.test(m[4] || '') && h === 12) h = 0;
    return `${pad2(h)}:${pad2(min)}`;
  }
  return null;
}

const EVENT_STATI = new Set(['Draft', 'Submitted', 'Approved', 'Rejected', 'Completed', 'Closed', 'Cancelled', 'Postponed']);

// Parse an events worksheet. Returns rows with header title-cased column keys
// (name, date, sectorLabel, activityLabel, ngoLabel, venue, startTime, endTime,
// status, budget, expectedBeneficiaries). Sector/activity/NGO are carried
// forward when blank (merged cells). At minimum an event name and a date are
// needed; sector + activity are resolved case-insensitively against the DB.
export function parseEventSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

  const lowerCell = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pick = (row, matchers, excludeRe) => {
    for (let c = 0; c < (row || []).length; c++) {
      const h = lowerCell(row[c]);
      if (h && matchers.some(re => re.test(h)) && !(excludeRe && excludeRe.test(h))) return c;
    }
    return -1;
  };

  // The "Event/Name" column must not match a date/sector/activity/ngo-like column.
  const NAME_EXCLUDE = /date|time|status|venue|budget|benef|sector|activity|\bngo\b|count|number|\bno\b|day/;
  let headerRow = -1;
  let cols = null;
  for (let r = 0; r < Math.min(rawRows.length, 30); r++) {
    const row = rawRows[r];
    const nameCol = pick(row, [/^event(\s|$)/, /^name(\s|$)/, /name of the event/], NAME_EXCLUDE);
    const dateCol = pick(row, [/^date/]);
    const dayCol = pick(row, [/^day(\s|$)/]);
    const sectorCol = pick(row, [/^sector/], /\bno\b|number|count/);
    const activityCol = pick(row, [/activity|project/], /\bno\b|number|count|type/);
    const ngoCol = pick(row, [/^ngo/], /activity/);
    const venueCol = pick(row, [/venue|location|place/]);
    const timeCol = pick(row, [/^time|start\s*time/]);
    const endCol = pick(row, [/end\s*time/]);
    const statusCol = pick(row, [/status/]);
    const budgetCol = pick(row, [/budget/]);
    const benCol = pick(row, [/beneficiar/]);
    if (nameCol !== -1) {
      headerRow = r;
      cols = { nameCol, dateCol, dayCol, sectorCol, activityCol, ngoCol, venueCol, timeCol, endCol, statusCol, budgetCol, benCol };
      break;
    }
  }

  if (!cols) {
    throw new Error('Could not find an "Event" (or "Name") column in the uploaded sheet');
  }

  // Detect the sheet layout:
  //  - calendar:  NGO | Event | Date | Day      (dated events, no catalog)
  //  - catalog:   NGO | Sector | Activity | Event (no dates -> builds All Events cascade + activities)
  //  - date:      full sheet with Event + Date (+ optional Sector/Activity/NGO)
  const hasDate = cols.dateCol !== -1;
  const hasCatalog = cols.sectorCol !== -1 && cols.activityCol !== -1;
  let format = 'date';
  if (hasDate && !hasCatalog) format = 'calendar';
  else if (!hasDate && hasCatalog) format = 'catalog';

  const rows = [];
  let lastSector = '';
  let lastActivity = '';
  let lastNgo = '';
  for (let r = headerRow + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    const cell = (c) => (c !== -1 ? String(row[c] ?? '').replace(/\s+/g, ' ').trim() : '');
    const sectorCell = cell(cols.sectorCol);
    const activityCell = cell(cols.activityCol);
    const ngoCell = cell(cols.ngoCol);
    if (sectorCell) lastSector = sectorCell;
    if (activityCell) lastActivity = activityCell;
    if (ngoCell) lastNgo = ngoCell;

    const name = cell(cols.nameCol);
    if (!name || /^(total|grand\s+total|sub\s+total)/i.test(name)) continue;
    const date = excelDateToISO(cols.dateCol !== -1 ? row[cols.dateCol] : null);

    const status = cell(cols.statusCol) || (hasDate ? 'Draft' : 'Approved');
    rows.push({
      name,
      date,
      format,
      sectorLabel: lastSector,
      activityLabel: lastActivity,
      ngoLabel: lastNgo,
      venue: cell(cols.venueCol) || null,
      startTime: excelTimeToHM(cols.timeCol !== -1 ? row[cols.timeCol] : null),
      endTime: excelTimeToHM(cols.endCol !== -1 ? row[cols.endCol] : null),
      status: EVENT_STATI.has(status) ? status : (hasDate ? 'Draft' : 'Approved'),
      budget: cols.budgetCol !== -1 && row[cols.budgetCol] !== undefined && row[cols.budgetCol] !== '' ? Number(row[cols.budgetCol]) : null,
      expectedBeneficiaries: cols.benCol !== -1 && row[cols.benCol] !== undefined && row[cols.benCol] !== '' ? Number(row[cols.benCol]) : null,
    });
  }

  return { rows, sheetName, format };
}