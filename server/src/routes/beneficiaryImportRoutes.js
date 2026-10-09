import { Router } from 'express';
import { authenticateRole, authenticate } from '../middleware/authMiddleware.js';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { createImportBatch, getImportBatch, updateImportBatch, addImportRows, getImportRows, updateImportRow, listImportBatches } from '../models/importBatchModel.js';
import { generateBeneficiaryCode, createBeneficiary, reserveBeneficiaryCodes, createBeneficiaries, updateBeneficiary, findByNumbers, runPooled, beneficiaryColumns, supportedFields } from '../models/beneficiaryModel.js';
import { addSourceRecord, addSourceRecords, findByOriginalData } from '../models/beneficiarySourceModel.js';
import { addDisability, addDisabilities, beneficiaryIdsWithDisabilities } from '../models/beneficiaryDisabilityModel.js';
import { logAuditEvent, logAuditEvents } from '../models/auditLogModel.js';
import db from '../config/db.js';
import { ensureBeneficiarySchema } from '../bootstrap/ensureBeneficiarySchema.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const router = Router();

const text = (v) => (v == null ? '' : String(v).trim());

// `needed` and friends are added by the bootstrap repair, not by migration
// 120, so an instance that has not been restarted since they were introduced
// has no such column and every INSERT fails with "column ... does not exist".
// The repair is idempotent, so the import runs it once per process instead of
// making the operator guess whether a restart is needed.
//
// It is best-effort: the repair swallows its own SQL errors, and this wrapper
// swallows anything else it might throw, so it can never turn a working import
// into a failed request. What the table really has is decided by the column
// read below.
let schemaReady = null;
const ensureImportSchema = () => {
  if (!schemaReady) {
    schemaReady = Promise.resolve()
      .then(() => ensureBeneficiarySchema())
      .catch((e) => {
        console.warn('[beneficiary import] schema repair skipped:', e?.message || e);
      });
  }
  return schemaReady;
};

// An INSERT that names a column the table does not have fails for every row
// alike, so retrying row by row would just repeat the same failure hundreds of
// times. Recognise those and surface them instead.
const isSchemaError = (e) => {
  const code = e?.code || '';
  const msg = String(e?.message || '');
  return code === '42703'                                   // undefined_column
    || code === '42P01'                                     // undefined_table
    || /column .* does not exist/i.test(msg)
    || /relation .* does not exist/i.test(msg);
};

// Sheet cells are messy: one cell can hold two numbers ("8268111557/ 9967777103")
// or a placeholder ("NA", "-", "0"). Pull the genuine 10-digit numbers out of
// the cell and ignore placeholders — concatenating everything and keeping the
// last 10 digits would silently turn a member's number into their alternate.
const PHONE_PLACEHOLDERS = new Set(['na', 'n/a', 'nil', 'none', 'null', 'undefined', '-', '--', '---', '0']);
const phoneList = (v) => {
  const s = text(v).replace(/\.0+$/, ''); // "8928460119.0"
  if (!s || PHONE_PLACEHOLDERS.has(s.toLowerCase())) return [];
  const found = [];
  for (const token of s.split(/[/,;|&\n\t]+|\s{2,}/)) {
    const digits = token.replace(/\D/g, '');
    if (digits.length >= 10) found.push(digits.slice(-10));
  }
  if (found.length === 0) {
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 10) found.push(digits.slice(0, 10));
  }
  return found;
};
const phone = (v) => phoneList(v)[0] || null;

const pct = (v) => {
  const n = Number.parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.round(n * 100) / 100);
};

// A date of birth has to be a real, plausible day, and it is checked here
// rather than trusted to the database. Handing an odd value straight to
// Postgres fails the whole import: a bare cell number like the Excel serial
// 42693 is not a date, so new Date() reads it as the *year* 42693 and emits
// "+042693-01-01T00:00:00.000Z", which Postgres rejects with "time zone
// displacement out of range". Silently storing the wrong century is worse.
const MIN_DOB_YEAR = 1900;
const isoDay = (y, m, d) => {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isInteger(year) || year < MIN_DOB_YEAR || year > new Date().getFullYear()) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  // Reject the likes of 31/02 that the calendar never had.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// Excel stores dates as a day count from 1900-01-01. Done by hand rather than
// through xlsx's SSF, which is only reachable on the CommonJS default export
// under Node's ESM interop and threw on every genuine date cell.
const fromSerial = (n) => {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null; // 9999-12-31
  // Excel counts a leap day that 1900 never had, so serials past 59 sit one
  // day ahead of a plain day count.
  const epoch = n > 59 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  const d = new Date(epoch + Math.floor(n) * 86400000);
  return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};

const ageToDob = (v) => {
  const years = Number.parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(years) || years <= 0 || years > 120) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() - Math.floor(years));
  return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

// Accepts Excel dates (serial numbers, ISO strings) and the usual Indian
// dd/mm/yyyy and dd-mm-yyyy written forms.
const toDob = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // The local calendar day, not toISOString(): that converts to UTC first
    // and can shift a midnight birth date back to the previous day.
    return isoDay(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return fromSerial(v);
  }
  const s = text(v);
  if (!s) return null;
  // A cell holding only digits is a serial date that arrived as text. Without
  // this it falls through to new Date() below and becomes a nonsense year.
  if (/^\d+(\.\d+)?$/.test(s)) {
    return fromSerial(Number(s));
  }
  // A JSON-serialised cell arrives as a full timestamp; take the calendar date
  // as written rather than re-deriving it in this server's time zone, which
  // can move a midnight birth date to the day before.
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);
  if (m) return isoDay(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    // 2-digit years pivot at 50: 92 -> 1992, 07 -> 2007.
    const year = m[3].length === 2 ? (Number(m[3]) >= 50 ? `19${m[3]}` : `20${m[3]}`) : m[3];
    return isoDay(year, m[2], m[1]);
  }
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return isoDay(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
};

const GENDER = { m: 'MALE', male: 'MALE', man: 'MALE', f: 'FEMALE', female: 'FEMALE', woman: 'FEMALE', o: 'OTHER', other: 'OTHER', t: 'TRANSGENDER', transgender: 'TRANSGENDER' };
const gender = (v) => GENDER[text(v).toLowerCase()] || text(v).toUpperCase() || null;

// "NGO" is free text in the sheet, matched against the NGO master list so the
// import lands on a real ngo_id. Sheets rarely repeat the registered name
// exactly ("Seva Foundation India" vs "Seva Foundation (Reg.)", "SEVA FOUNDATION",
// "Seva Foundation - Pune"), so fall back to a containment match and only accept
// it when exactly one registered NGO qualifies - guessing between two would
// silently file a member under the wrong organisation.
const ngoKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
const NGO_NOISE = /\b(reg|registered|registration|india|india|trust|foundation|society|association|ngo|ngos|project|pune|mumbai|nagpur|aurangabad|beed|jalna|solapur|osmanabad|latur)\b/g;

const loadNgoLookup = async () => {
  const byId = new Map();
  const exact = new Map();
  const loose = [];
  const names = new Map();
  const { data, error } = await db.from('ngos').select('id, name, code');
  if (error) throw error;
  for (const n of data || []) {
    // ngos.id is int4/int8/uuid depending on the installation, so index the id
    // as a string and let the caller compare with String(id) === String(value).
    if (n.id != null && !byId.has(String(n.id))) byId.set(String(n.id), n.id);
    if (n.name && !names.has(n.id)) names.set(n.id, n.name);
    for (const raw of [n.name, n.code]) {
      const k = ngoKey(raw);
      if (!k) continue;
      if (!exact.has(k)) exact.set(k, n.id);
      // Also index the name without the noise words so a sheet that drops or
      // adds them still lines up.
      const stripped = k.replace(NGO_NOISE, '');
      if (stripped.length >= 4 && stripped !== k) {
        const hit = loose.find((e) => e.key === stripped);
        if (hit) { if (!hit.ids.includes(n.id)) hit.ids.push(n.id) } else loose.push({ key: stripped, ids: [n.id] })
      }
    }
  }
  return { byId, exact, loose, names };
};

const resolveNgo = (lookup, v) => {
  const k = ngoKey(v);
  if (!k) return null;
  const hit = lookup.exact.get(k);
  if (hit) return hit;

  const stripped = k.replace(NGO_NOISE, '');
  const candidates = [];
  for (const entry of lookup.loose) {
    if (entry.key === stripped || stripped.includes(entry.key) || entry.key.includes(stripped)) {
      for (const id of entry.ids) if (!candidates.includes(id)) candidates.push(id);
    }
  }
  if (candidates.length === 1) return candidates[0];

  // Last resort: a registered name contained in the sheet value ("Pune Trust"
  // for "Pune Trust for Rural Development"). Still only when unambiguous.
  if (candidates.length === 0) {
    for (const [name, id] of lookup.exact) {
      if (name.length >= 6 && k.includes(name) && !candidates.includes(id)) candidates.push(id);
    }
    if (candidates.length === 1) return candidates[0];
  }
  return null;
};

// Upload and parse Excel
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames;

    // Parse each sheet and count rows
    const sheets = {};
    for (const name of sheetNames) {
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[name]);
      sheets[name] = { rows: data.length, headers: data.length > 0 ? Object.keys(data[0]) : [] };
    }

    // Create import batch
    const batch = await createImportBatch({
      file_name: req.file.originalname,
      total_rows: Object.values(sheets).reduce((sum, s) => sum + s.rows, 0),
      status: 'PENDING',
      imported_by: req.user?.name || req.user?.email || 'system',
    });

    return res.status(201).json({
      batch,
      sheets: Object.entries(sheets).map(([name, info]) => ({
        name, rows: info.rows, headers: info.headers,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// ── Member sheet import (Accounts panel → Beneficiaries → Import Members) ──
// The panel parses the workbook in the browser and posts the mapped rows, so
// this endpoint only does the parts that need the database: Age → date_of_birth
// and the create/merge itself.
//
// The NGO is not a sheet column. The panel asks which NGO the import is for and
// sends ngo_id once; every member in the file is linked to it.
//
// Sheet columns: Member Name, Number, % of Disability, Type of Disability,
// Alternate Number, Location, Needed Type, State, Age, DOB, Gender.
router.post('/members', authenticateRole('super_admin', 'admin', 'ngo', 'accounts'), async (req, res) => {
  const { rows, file_name: fileName, ngo_id: requestedNgoId } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ message: 'rows array is required' });
  }

  // Make sure the columns this INSERT names actually exist before touching a
  // single row. The repair is best-effort by design — it swallows its own
  // errors — so it never blocks an import; the column read below is the real
  // gate, and it turns a stale schema into a clear answer either way.
  await ensureImportSchema();

  // Write only the columns this installation actually has. Anything else is
  // reported per row rather than silently dropped.
  let bColumns = new Set();
  try {
    bColumns = await beneficiaryColumns();
  } catch (e) {
    console.error('[beneficiary import] could not read the beneficiaries columns:', e.message);
    return res.status(500).json({
      message: `Could not read the beneficiaries table structure (${e.message}).`,
      summary: { created: 0, updated: 0, no_change: 0, skipped: 0, errors: 0 },
      results: [],
      failed: true,
    });
  }

  // Express 4 does not catch a rejected promise from an async handler: the
  // request would simply never respond and the panel would sit on
  // "Importing..." forever. Everything below is wrapped so any failure turns
  // into a real answer.
  try {
  const performedBy = req.user?.name || req.user?.email || 'system';
  const created_by = req.user?.name || req.user?.email || 'system';

  // The chosen NGO is validated once, not per row, so a bad id fails the whole
  // import loudly instead of silently importing members with no NGO.
  let ngoLookup = { byId: new Map(), exact: new Map(), loose: [], names: new Map() };
  let importNgoId = null;
  try {
    ngoLookup = await loadNgoLookup();
  } catch (e) {
    // An unreachable database is not the same thing as an unknown NGO. Saying
    // "pick it again" here would send the operator hunting for the wrong
    // problem, so report what actually went wrong.
    console.error('[beneficiary import] NGO lookup failed:', e.message);
    return res.status(500).json({
      message: `Could not reach the database to check the selected NGO (${e.message}). Try again in a moment.`,
      summary: { created: 0, updated: 0, no_change: 0, skipped: 0, errors: 0 },
      results: [],
      failed: true,
    });
  }
  if (requestedNgoId) {
    const wanted = String(requestedNgoId).trim();
    // The panel sends whatever /ngos/options returned as the value, which is a
    // string of an int, bigint or uuid. Match it as a string first; fall back
    // to the name/code path so a hand-made request still works.
    importNgoId = ngoLookup.byId.get(wanted)
      ?? ngoLookup.exact.get(ngoKey(wanted))
      ?? resolveNgo(ngoLookup, wanted);
    if (!importNgoId) {
      return res.status(400).json({ message: 'The selected NGO no longer exists. Pick it again.' });
    }
  }

  let batch = null;
  try {
    batch = await createImportBatch({
      file_name: text(fileName) || `member-import-${new Date().toISOString().slice(0, 10)}.xlsx`,
      total_rows: rows.length,
      status: 'PENDING',
      imported_by: performedBy,
    });
  } catch (e) {
    // Never let bookkeeping stop the import itself.
    console.error('[beneficiary import] batch setup failed:', e.message);
  }

  const results = [];
  const staging = [];
  const summary = { created: 0, updated: 0, no_change: 0, skipped: 0, errors: 0 };
  const imported = [];

  // ── 1. Normalise every row (no I/O) ────────────────────────────────────────
  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const rowNumber = Number(row._rowNumber) || i + 2;
    const name = text(row.full_name || row.name);
    // A single cell may carry both numbers ("8268111557/ 9967777103"); the
    // second one becomes the alternate when that column is empty.
    const primaryNumbers = phoneList(row.mobile);
    const mobile = primaryNumbers[0] || null;
    const alternateMobile = phoneList(row.alternate_mobile)[0] || primaryNumbers[1] || null;
    const warnings = [];

    if (!name) {
      summary.skipped++;
      results.push({ row: rowNumber, status: 'skipped', name: '', message: 'Member Name is empty', warnings });
      staging.push({ batch_id: batch?.id ?? null, row_number: rowNumber, raw_data: row, status: 'INVALID', validation_errors: { errors: ['Member Name is empty'] } });
      continue;
    }

    const dob = toDob(row.date_of_birth) || ageToDob(row.age);
    if (!toDob(row.date_of_birth) && row.age && !dob) {
      warnings.push('Age could not be read, DOB left empty');
    }
    const location = text(row.location);
    const state = text(row.state);
    // "Needed Type" (what the member needs) is a plain text field of its own;
    // "NGO" (who serves them) resolves to ngo_id. They are separate columns.
    const needed = text(row.needed);
    const disabilityType = text(row.disability_type);
    const disabilityPercentage = pct(row.disability_percentage);
    const g = gender(row.gender);

    // The NGO comes from the picker at the top of the page, not the sheet.
    const ngoId = importNgoId;
    // The panel sends the label it showed; prefer the master's name, but fall
    // back to it so a nameless NGO row still reads sensibly in the report.
    const ngoName = (ngoId ? ngoLookup.names.get(ngoId) : null) || text(req.body?.ngo_name) || null;
    if (!ngoId) {
      warnings.push('No NGO was selected for this import, so the member was saved without one');
    }
    if (disabilityPercentage != null && !disabilityType) {
      warnings.push('Disability % present without a Type — recorded as "General"');
    }

    parsed.push({
      row, rowNumber, name, mobile, alternateMobile, warnings,
      dob, location, state, needed, ngoId, ngoName,
      disabilityType, disabilityPercentage, gender: g,
    });
  }

  // ── 2. Look up every existing member in one query ─────────────────────────
  let existingByNumber = new Map();
  try {
    existingByNumber = await findByNumbers(parsed.map((p) => p.mobile));
  } catch (e) {
    console.error('[beneficiary import] existing member lookup failed:', e.message);
  }

  // Which of the matched members already have a disability on file, so a
  // re-import doesn't add a second one.
  const matchedIds = [...new Set([...existingByNumber.values()].map((b) => b.id))];
  let idsWithDisability = new Set();
  try {
    idsWithDisability = await beneficiaryIdsWithDisabilities(matchedIds);
  } catch (e) {
    console.error('[beneficiary import] disability lookup failed:', e.message);
  }

  // ── 3. Merge the already-on-file members ─────────────────────────────────
  const toCreate = [];
  const mergePatches = [];
  for (const p of parsed) {
    const existing = p.mobile ? existingByNumber.get(p.mobile) : null;

    if (existing) {
      // Merge: only fill the blanks so nothing already on file is overwritten.
      const patch = {};
      const fill = (column, value) => {
        if (value != null && value !== '' && !text(existing[column])) patch[column] = value;
      };
      fill('full_name', p.name);
      fill('mobile', p.mobile);
      fill('alternate_mobile', p.alternateMobile);
      fill('date_of_birth', p.dob);
      fill('gender', p.gender);
      fill('address_line_1', p.location);
      fill('state', p.state);
      fill('needed', p.needed);
      fill('ngo_id', p.ngoId);

      let willPatch = false;
      if (Object.keys(patch).length > 0) {
        const { kept, dropped } = supportedFields(patch, bColumns);
        if (dropped.length > 0 && !p.droppedColumns) {
          p.droppedColumns = dropped;
          p.warnings.push(`This database has no "${dropped.join('", "')}" column, so that detail was not saved`);
        }
        if (Object.keys(kept).length > 0) {
          willPatch = true;
          mergePatches.push({ id: existing.id, values: { ...kept, updated_by: created_by }, rowNumber: p.rowNumber });
        }
      }

      // Add the disability only when the member has none recorded yet.
      const disabilityAdded = (p.disabilityType || p.disabilityPercentage != null)
        && !idsWithDisability.has(existing.id);

      // Only claim "updated" for a field that is actually written.
      const changed = willPatch || disabilityAdded;
      if (changed) summary.updated++; else summary.no_change++;
      results.push({
        row: p.rowNumber, status: changed ? 'updated' : 'no_change', name: p.name,
        mobile: p.mobile, beneficiary_id: existing.id, beneficiary_code: existing.beneficiary_code,
        needed: p.needed, ngo_name: p.ngoName,
        message: changed ? 'Existing member updated with the missing details' : 'Already up to date',
        warnings: p.warnings,
      });
      staging.push({
        batch_id: batch?.id ?? null, row_number: p.rowNumber, raw_data: p.row, mapped_data: p.row,
        status: changed ? 'UPDATED' : 'NO_CHANGE', beneficiary_id: existing.id,
        validation_errors: p.warnings.length ? { warnings: p.warnings } : null,
      });
      continue;
    }

    toCreate.push(p);
  }

  // Apply the merges concurrently — each row sets a different column set, so
  // they can't share one statement, but they don't need to queue up either.
  if (mergePatches.length > 0) {
    await runPooled(mergePatches, 8, async (m) => {
      try {
        await updateBeneficiary(m.id, m.values);
      } catch (e) {
        console.error(`[beneficiary import] row ${m.rowNumber} update failed:`, e.message);
      }
    });
  }

  // ── 4. Create the new members in one batch ───────────────────────────────
  // Codes are reserved up front so the whole file costs one read+write on the
  // sequence instead of two round-trips per member.
  let codes = [];
  if (toCreate.length > 0) {
    try {
      codes = await reserveBeneficiaryCodes(toCreate.length);
    } catch (e) {
      console.error('[beneficiary import] code reservation failed:', e.message);
    }
  }

  const newDisabilityRows = [];
  const newSourceRows = [];
  const newAuditRows = [];

  const insertRows = toCreate.map((p, i) => {
    const beneficiary_code = codes[i] || null;
    p.beneficiary_code = beneficiary_code;
    if (!beneficiary_code) {
      p.warnings.push('Could not allocate a beneficiary code; the member was saved without one');
    }
    newDisabilityRows.push({
      _row: p,
      disability_type: p.disabilityType || 'General',
      disability_percentage: p.disabilityPercentage,
      certificate_available: false,
    });
    newSourceRows.push({
      _row: p,
      source_type: 'IMPORT',
      source_file: batch?.file_name || text(fileName) || null,
      original_name: p.name,
      original_data: p.row,
      import_batch_id: batch?.id ?? null,
    });
    newAuditRows.push({
      _row: p,
      entity_type: 'beneficiary',
      action: 'IMPORTED',
      performed_by: performedBy,
    });
    const { kept, dropped } = supportedFields({
      beneficiary_code,
      full_name: p.name,
      date_of_birth: p.dob,
      gender: p.gender,
      mobile: p.mobile,
      alternate_mobile: p.alternateMobile,
      address_line_1: p.location || null,
      state: p.state || null,
      needed: p.needed || null,
      ngo_id: p.ngoId,
      status: 'ACTIVE',
      fingerprint_status: 'NOT_REGISTERED',
      created_by,
      updated_by: created_by,
    }, bColumns);
    if (dropped.length > 0 && !p.droppedColumns) {
      p.droppedColumns = dropped;
      p.warnings.push(`This database has no "${dropped.join('", "')}" column, so that detail was not saved`);
    }
    return kept;
  }).filter((r) => r.beneficiary_code);

  // A bulk insert is all-or-nothing, so fall back to row-by-row if the batch is
  // rejected — one malformed row must not cost the other 441 members. A schema
  // problem is different: it fails identically for every row, so re-sending the
  // whole file one row at a time would only turn one clear error into a long
  // wait for the same error.
  const insertChunk = async (rows) => {
    if (rows.length === 0) return [];
    try {
      return await createBeneficiaries(rows);
    } catch (e) {
      if (isSchemaError(e)) {
        console.error('[beneficiary import] insert rejected by the schema:', e.message);
        throw Object.assign(
          new Error(`The beneficiaries table is missing a column this import needs (${e.message}). Restart the backend and try again.`),
          { schemaError: true },
        );
      }
      console.error('[beneficiary import] bulk insert failed, retrying row by row:', e.message);
      const saved = [];
      let consecutiveFailures = 0;
      for (const r of rows) {
        try {
          saved.push(...await createBeneficiaries([r]));
          consecutiveFailures = 0;
        } catch (rowErr) {
          if (isSchemaError(rowErr) || ++consecutiveFailures >= 5) {
            // Every row is failing the same way; stop instead of grinding
            // through the rest of the file.
            console.error('[beneficiary import] aborting row-by-row retry:', rowErr.message);
            throw Object.assign(new Error(rowErr.message), { schemaError: isSchemaError(rowErr) });
          }
          const p = toCreate.find((c) => c.beneficiary_code === r.beneficiary_code);
          console.error(`[beneficiary import] row ${p?.rowNumber} failed:`, rowErr.message);
          if (p) {
            summary.errors++;
            results.push({ row: p.rowNumber, status: 'error', name: p.name, mobile: p.mobile, message: rowErr.message, warnings: p.warnings });
            staging.push({ batch_id: batch?.id ?? null, row_number: p.rowNumber, raw_data: p.row, status: 'ERROR', validation_errors: { error: rowErr.message } });
          }
        }
      }
      return saved;
    }
  };

  const CHUNK = 100;
  const createdAll = [];
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    createdAll.push(...await insertChunk(insertRows.slice(i, i + CHUNK)));
  }
  // PostgREST rejects very large statement bodies; 100 keeps each insert well
  // inside its limits.
  // PostgREST returns inserted rows in insert order, but the code we assigned is
  // a safer key than position.
  const createdByCode = new Map(createdAll.map((b) => [b.beneficiary_code, b]));

  // ── 5. Side tables in bulk ───────────────────────────────────────────────
  const createdIds = createdAll.map((b) => b.id);
  const disabilitiesForCreated = newDisabilityRows
    .filter((d) => createdByCode.has(d._row.beneficiary_code))
    .map((d) => ({
      beneficiary_id: createdByCode.get(d._row.beneficiary_code).id,
      disability_type: d.disability_type,
      disability_percentage: d.disability_percentage,
      certificate_available: d.certificate_available,
    }));
  for (let i = 0; i < disabilitiesForCreated.length; i += CHUNK) {
    try {
      await addDisabilities(disabilitiesForCreated.slice(i, i + CHUNK));
    } catch (e) {
      console.error('[beneficiary import] disability insert failed:', e.message);
    }
  }

  const sourceRows = newSourceRows
    .filter((s) => createdByCode.has(s._row.beneficiary_code))
    .map(({ _row, ...rest }) => ({
      ...rest,
      beneficiary_id: createdByCode.get(_row.beneficiary_code).id,
    }));
  for (let i = 0; i < sourceRows.length; i += CHUNK) {
    try {
      await addSourceRecords(sourceRows.slice(i, i + CHUNK));
    } catch (e) {
      console.error('[beneficiary import] source record insert failed:', e.message);
    }
  }

  const auditRows = newAuditRows
    .filter((a) => createdByCode.has(a._row.beneficiary_code))
    .map(({ _row, ...rest }) => ({
      ...rest,
      entity_id: createdByCode.get(_row.beneficiary_code).id,
      beneficiary_id: createdByCode.get(_row.beneficiary_code).id,
      details: { batch_id: batch?.id ?? null, beneficiary_code: _row.beneficiary_code },
    }));
  for (let i = 0; i < auditRows.length; i += CHUNK) {
    try {
      await logAuditEvents(auditRows.slice(i, i + CHUNK));
    } catch (e) {
      console.error('[beneficiary import] audit log insert failed:', e.message);
    }
  }

  // Disability rows for merges that had none, now that we know the ids.
  const mergeDisabilities = [];
  for (const r of results) {
    if (r.status !== 'updated' || !r.beneficiary_id) continue;
    const p = parsed.find((x) => x.rowNumber === r.row && x.name === r.name);
    if (!p || !(p.disabilityType || p.disabilityPercentage != null)) continue;
    if (idsWithDisability.has(r.beneficiary_id)) continue;
    mergeDisabilities.push({
      beneficiary_id: r.beneficiary_id,
      disability_type: p.disabilityType || 'General',
      disability_percentage: p.disabilityPercentage,
      certificate_available: false,
    });
  }
  for (let i = 0; i < mergeDisabilities.length; i += CHUNK) {
    try {
      await addDisabilities(mergeDisabilities.slice(i, i + CHUNK));
    } catch (e) {
      console.error('[beneficiary import] merged-member disability insert failed:', e.message);
    }
  }

  // ── 6. Report ────────────────────────────────────────────────────────────
  for (const p of toCreate) {
    const b = createdByCode.get(p.beneficiary_code);
    if (!b) {
      if (results.some((r) => r.row === p.rowNumber && r.status === 'error')) continue;
      summary.errors++;
      results.push({ row: p.rowNumber, status: 'error', name: p.name, mobile: p.mobile, message: 'Member could not be saved', warnings: p.warnings });
      staging.push({ batch_id: batch?.id ?? null, row_number: p.rowNumber, raw_data: p.row, status: 'ERROR', validation_errors: { error: 'Member could not be saved' } });
      continue;
    }
    summary.created++;
    imported.push(b);
    results.push({
      row: p.rowNumber, status: 'created', name: p.name, mobile: p.mobile,
      needed: p.needed, ngo_name: p.ngoName,
      beneficiary_id: b.id, beneficiary_code: b.beneficiary_code, message: 'Member added', warnings: p.warnings,
    });
    staging.push({
      batch_id: batch?.id ?? null, row_number: p.rowNumber, raw_data: p.row, mapped_data: p.row,
      status: 'VALID', beneficiary_id: b.id,
      validation_errors: p.warnings.length ? { warnings: p.warnings } : null,
    });
  }

  results.sort((a, b) => a.row - b.row);
  staging.sort((a, b) => a.row_number - b.row_number);


  if (batch) {
    await updateImportBatch(batch.id, {
      valid_rows: summary.created + summary.updated,
      warning_rows: results.filter((r) => r.warnings?.length).length,
      duplicate_rows: summary.no_change,
      error_rows: summary.errors + summary.skipped,
      status: 'COMPLETED',
      imported_at: new Date().toISOString(),
    }).catch((e) => console.error('[beneficiary import] batch update failed:', e.message));
  }
  for (let i = 0; i < staging.length; i += CHUNK) {
    await addImportRows(staging.slice(i, i + CHUNK))
      .catch((e) => console.error('[beneficiary import] row staging failed:', e.message));
  }

  return res.json({ summary, results, batch_id: batch?.id ?? null, imported });
  } catch (error) {
    console.error('[beneficiary import] failed:', error);
    return res.status(500).json({
      message: error?.message || 'The import could not be completed.',
      summary: { created: 0, updated: 0, no_change: 0, skipped: 0, errors: 0 },
      results: [],
      failed: true,
    });
  }
});

// Map columns and preview
router.post('/:batchId/preview', authenticate, async (req, res) => {
  try {
    const batch = await getImportBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });

    const { sheet_name, column_mapping } = req.body;
    // column_mapping: { beneficiary_full_name: 'A', mobile: 'B', ... }

    // Re-read the file to get data
    // For now, return placeholder - full implementation would re-read from S3
    return res.json({
      batch,
      message: 'Preview ready',
      column_mapping,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Import rows from batch
router.post('/:batchId/confirm', authenticate, async (req, res) => {
  try {
    const batch = await getImportBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });

    const { rows } = req.body;
    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ message: 'rows array is required' });
    }

    const created_by = req.user?.name || req.user?.email || 'system';
    let validCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;
    const importedBeneficiaries = [];

    for (const row of rows) {
      try {
        // Check for duplicates
        const duplicates = await findByOriginalData({
          mobile: row.mobile,
          full_name: row.full_name,
          // Normalised so a sheet holding "42693" still matches a member saved
          // as 2016-11-19.
          date_of_birth: toDob(row.date_of_birth),
        });

        if (duplicates.length > 0) {
          duplicateCount++;
          await addImportRows([{
            batch_id: batch.id,
            row_number: row._rowNumber || 0,
            raw_data: JSON.stringify(row),
            mapped_data: JSON.stringify(row),
            status: 'DUPLICATE',
            validation_errors: JSON.stringify({ duplicates: duplicates.map(d => d.beneficiary_code) }),
          }]);
          continue;
        }

        const beneficiary_code = await generateBeneficiaryCode();
        const beneficiary = await createBeneficiary({
          beneficiary_code,
          full_name: row.full_name || row.name || '',
          first_name: row.first_name,
          last_name: row.last_name,
          // Same reasoning as the lookup above: never hand the raw cell to
          // Postgres, or an Excel serial becomes a year and the insert fails.
          date_of_birth: toDob(row.date_of_birth),
          gender: row.gender,
          mobile: row.mobile,
          alternate_mobile: row.alternate_mobile,
          email: row.email,
          address_line_1: row.address || row.address_line_1,
          city: row.city,
          district: row.district,
          state: row.state,
          pincode: row.pincode,
          status: row.status || 'ACTIVE',
          ngo_id: req.user?.ngo_id || null,
          created_by, updated_by: created_by,
        });

        await addSourceRecord(beneficiary.id, {
          source_type: 'IMPORT',
          source_file: batch.file_name,
          original_name: row.full_name || row.name,
          original_data: JSON.stringify(row),
          import_batch_id: batch.id,
        });

        await logAuditEvent({
          entity_type: 'beneficiary', entity_id: beneficiary.id,
          beneficiary_id: beneficiary.id, action: 'IMPORTED',
          details: { batch_id: batch.id, beneficiary_code },
          performed_by: created_by,
        });

        validCount++;
        importedBeneficiaries.push(beneficiary);
      } catch (err) {
        errorCount++;
        await addImportRows([{
          batch_id: batch.id,
          row_number: row._rowNumber || 0,
          raw_data: JSON.stringify(row),
          status: 'ERROR',
          validation_errors: JSON.stringify({ error: err.message }),
        }]);
      }
    }

    await updateImportBatch(batch.id, {
      valid_rows: validCount,
      duplicate_rows: duplicateCount,
      error_rows: errorCount,
      status: 'COMPLETED',
      imported_at: new Date().toISOString(),
    });

    return res.json({
      message: 'Import completed',
      valid: validCount,
      duplicates: duplicateCount,
      errors: errorCount,
      beneficiaries: importedBeneficiaries,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// List batches
router.get('/', authenticate, async (req, res) => {
  try {
    const { page, pageSize } = req.query;
    const result = await listImportBatches({ page: parseInt(page) || 1, pageSize: parseInt(pageSize) || 25 });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Get batch detail
router.get('/:batchId', authenticate, async (req, res) => {
  try {
    const batch = await getImportBatch(req.params.batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    const rows = await getImportRows(batch.id);
    return res.json({ batch, rows });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

export default router;
