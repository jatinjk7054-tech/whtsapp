import {
  createSimCard,
  getAllSimCards,
  getSimCardById,
  updateSimCard,
  deleteSimCard,
  createReplacement,
  getAllReplacements,
  getReplacementsBySimCard,
  deleteReplacementsBySimCard,
  bulkInsertSimCards,
  createSimCardHistory,
  getSimCardHistory,
  listSimCardHistory,
} from '../models/simCardModel.js';

export const SIM_STATUSES = ['Active', 'Expiring Soon', 'Expired', 'Replaced', 'Inactive'];

export const requiredFields = [
  'mobile_id',
];

/* Every column the SIM panel is allowed to write.
 *
 * The Add form posts owner, ngo, w1_name, gb, sim_type and all 20 SIM slots in
 * one payload, and PostgREST rejects the ENTIRE statement when any single key
 * is not a real column on sim_cards. An installation that never had migration
 * 114/117 applied therefore failed every Add with
 *   {"message":"column sim_cards.owner does not exist"}
 * and nothing saved, while the rest of the panel kept working. migrations/154
 * brings the schema up to date; filtering the body down to this list means any
 * column that has not been migrated on a given database drops out of the write
 * (stored as NULL) instead of taking the whole save down with it.
 *
 * The key set is fixed rather than derived from the request body on purpose: a
 * bulk insert requires every object to carry identical keys, so a spreadsheet
 * row that happens to omit `owner` would otherwise disagree with a row that
 * includes it and fail the whole import. */
const writableFields = [
  'mobile_id', 'device_model', 'imei', 'team', 'signature', 'ngo', 'owner',
  'sim_type', 'gb', 'remark', 'notes', 'calling_mobile', 'use_for',
  'team_leader_name', 'user_name', 'w1_name', 'w2_name', 'w3_name', 'w4_name',
  'issue_date', 'expiry_date', 'status', 'replacement_count', 'created_by',
  ...Array.from({ length: 20 }, (_, i) => `sim_${i + 1}`),
];

const dateFields = new Set(['issue_date', 'expiry_date']);

/* Reduces a request body or an imported spreadsheet row to exactly
 * writableFields, with absent values normalised to NULL. The date columns are
 * truncated to YYYY-MM-DD so an Excel cell carrying a timestamp or a
 * dd-Mon-yy label cannot be rejected by the date cast. */
function clean(data) {
  const src = data || {};
  const c = {};
  writableFields.forEach((k) => {
    const v = src[k];
    if (v === undefined || v === null || v === '') c[k] = null;
    else if (dateFields.has(k)) c[k] = String(v).slice(0, 10);
    else c[k] = v;
  });
  c.replacement_count = Number(c.replacement_count) || 0;
  return c;
}

export function computeExpiry(expiryDate, today = new Date()) {
  if (!expiryDate) {
    return { daysLeft: null, dcStatus: 'Inactive' };
  }
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const end = new Date(`${expiryDate}T00:00:00`).getTime();
  const days = Math.round((end - start) / 86400000);
  if (days > 5) return { daysLeft: days, dcStatus: 'Active' };
  if (days >= 1) return { daysLeft: days, dcStatus: 'Expiring Soon' };
  return { daysLeft: days, dcStatus: 'Expired' };
}

function finalStatus(card, expiry) {
  const base = (card.status || 'Active').trim();
  if (base === 'Replaced') return 'Replaced';
  if (base === 'Inactive') return 'Inactive';
  if (base === 'Expired') return 'Expired';
  return expiry.dcStatus;
}

export const addSimCard = async (req, res) => {
  try {
    const body = clean(req.body);
    if (requiredFields.some((f) => !body[f] || !String(body[f]).trim())) {
      return res.status(400).json({ message: 'Required fields are missing' });
    }
    const { daysLeft, dcStatus } = computeExpiry(body.expiry_date);
    body.status = body.status && SIM_STATUSES.includes(body.status)
      ? body.status
      : finalStatus({ status: body.status || 'Active' }, { daysLeft, dcStatus });
    body.replacement_count = Number(body.replacement_count) || 0;
    body.created_by = req.user?.login_id || req.user?.id || req.user?.name || null;
    const sim = await createSimCard(body);
    return res.status(201).json({ message: 'SIM card added', sim, daysLeft });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listSimCards = async (req, res) => {
  try {
    const cards = await getAllSimCards();
    const now = new Date();
    const withMeta = cards.map((c) => {
      const storedDaysLeft = c.days_left !== null && c.days_left !== undefined ? c.days_left : null;
      const { daysLeft, dcStatus } = computeExpiry(c.expiry_date, now);
      const status = finalStatus(c, { daysLeft, dcStatus });
      return { ...c, days_left: storedDaysLeft !== null ? storedDaysLeft : daysLeft, derived_status: status };
    });
    return res.json(withMeta);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getSimCard = async (req, res) => {
  try {
    const sim = await getSimCardById(req.params.id);
    if (!sim) return res.status(404).json({ message: 'SIM card not found' });
    const storedDaysLeft = sim.days_left !== null && sim.days_left !== undefined ? sim.days_left : null;
    const { daysLeft } = computeExpiry(sim.expiry_date);
    return res.json({ ...sim, days_left: storedDaysLeft !== null ? storedDaysLeft : daysLeft });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const patchSimCard = (body) => {
  const patch = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (k === 'id' || k === 'created_at' || k === 'updated_at') continue;
    if (v === '' || v === null || v === undefined) continue;
    patch[k] = v;
  }
  return patch;
};

export const editSimCard = async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.mobile_id || !String(body.mobile_id).trim()) {
      return res.status(400).json({ message: 'Mobile ID No. is required' });
    }
    const writable = {};
    const nonNullableText = ['mobile_id', 'device_model', 'imei', 'team', 'signature', 'ngo'];
    /* Walk the whitelist rather than the request body. listSimCards hands the
     * client a `derived_status` field that is computed, not stored, so echoing a
     * card back would otherwise try to write a column that does not exist - the
     * same "column sim_cards.x does not exist" failure as the Add form, this time
     * on save. `created_by` is a create-time audit field and is never rewritten
     * by an edit. */
    for (const k of writableFields) {
      if (k === 'created_by') continue;
      if (!(k in body)) continue;
      const v = body[k];
      if (nonNullableText.includes(k)) {
        writable[k] = v === null || v === undefined ? null : String(v);
        if (writable[k] === '') writable[k] = null;
        continue;
      }
      if (v === undefined) continue;
      writable[k] = v === '' || v === null ? null : v;
      if (dateFields.has(k) && typeof writable[k] === 'string') writable[k] = writable[k].slice(0, 10);
    }
    const patch = writable;

    let daysLeft = null;
    if ('expiry_date' in patch) {
      const computed = computeExpiry(patch.expiry_date);
      daysLeft = computed.daysLeft;
      if (patch.status === null || patch.status === undefined) {
        patch.status = finalStatus({ status: 'Active' }, computed);
      }
    }
    const beforeSim = await getSimCardById(req.params.id);
    if (!beforeSim) {
      return res.status(404).json({ message: 'SIM card not found' });
    }
    const changedCols = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'updated_at') continue;
      const prev = beforeSim[k] ?? null;
      const newVal = v ?? null;
      if (String(prev) !== String(newVal)) {
        changedCols[k] = { old: prev, new: newVal };
      }
    }
    const sim = await updateSimCard(req.params.id, patch);
    if (Object.keys(changedCols).length > 0) {
      const changedBy = req.user?.login_id || req.user?.name || req.user?.id || null;
      try {
        await createSimCardHistory({
          sim_card_id: beforeSim.id,
          changed_by: changedBy,
          changed_cols: changedCols,
          before_data: beforeSim,
          after_data: { ...beforeSim, ...patch },
        });
      } catch (e) {
        // history write failure should not block the update
      }
    }
    return res.json({ message: 'SIM card updated', sim, daysLeft });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const historyForSim = async (req, res) => {
  try {
    const history = await getSimCardHistory(req.params.id);
    return res.json(history);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Brand-wide number-change log backing the Nokia/Android history option.
// Read-only: this never writes, it only widens the existing audit trail across
// every card of a brand in one request.
const HISTORY_BRANDS = ['all', 'nokia', 'android'];

export const historyAll = async (req, res) => {
  try {
    const asked = String(req.query.brand || 'all').toLowerCase();
    const brand = HISTORY_BRANDS.includes(asked) ? asked : 'all';
    // Accept a plain YYYY-MM-DD prefix; anything else is ignored so a bad query
    // string degrades to "all time" instead of erroring or emptying the log.
    const rawFrom = String(req.query.from || '').trim();
    const from = /^\d{4}-\d{2}-\d{2}/.test(rawFrom) ? rawFrom : null;
    const history = await listSimCardHistory({ brand, from });
    return res.json(history);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeSimCard = async (req, res) => {
  try {
    await deleteReplacementsBySimCard(req.params.id);
    await deleteSimCard(req.params.id);
    return res.json({ message: 'SIM card deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const replaceSimCard = async (req, res) => {
  try {
    const sim = await getSimCardById(req.params.id);
    if (!sim) return res.status(404).json({ message: 'SIM card not found' });
    const { new_sim, replacement_date, reason, new_expiry_date } = req.body;
    if (!new_sim || !String(new_sim).trim()) {
      return res.status(400).json({ message: 'New SIM number is required' });
    }
    const oldSim = sim.sim_1 || sim.mobile_id || '';
    const rep = await createReplacement({
      sim_card_id: sim.id,
      replacement_date: replacement_date || new Date().toISOString().slice(0, 10),
      old_sim: oldSim,
      new_sim: String(new_sim).trim(),
      device: sim.device_model || null,
      reason: reason || '',
      new_expiry_date: new_expiry_date || sim.expiry_date,
      changed_by: req.user?.login_id || req.user?.name || req.user?.id || null,
    });
    const nextCount = (Number(sim.replacement_count) || 0) + 1;
    const updates = {
      sim_1: String(new_sim).trim(),
      replacement_count: nextCount,
      status: 'Active',
    };
    if (new_expiry_date) updates.expiry_date = new_expiry_date;
    const updated = await updateSimCard(sim.id, { ...updates, expiry_date: new_expiry_date || sim.expiry_date });
    const { daysLeft } = computeExpiry(updates.expiry_date);
    return res.status(200).json({ message: 'SIM card replaced', sim: updated, replacement: rep, daysLeft });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listReplacements = async (req, res) => {
  try {
    const reps = await getAllReplacements();
    return res.json(reps);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const replaceHistoryForSim = async (req, res) => {
  try {
    const reps = await getReplacementsBySimCard(req.params.id);
    return res.json(reps);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateStatusBulk = async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No SIM cards selected' });
    }
    if (!SIM_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    let updated = 0;
    for (const id of ids) {
      await updateSimCard(id, { status });
      updated += 1;
    }
    return res.json({ message: `${ids.length} SIM card(s) updated`, updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteBulk = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No SIM cards selected' });
    }
    for (const id of ids) {
      await deleteReplacementsBySimCard(id);
      await deleteSimCard(id);
    }
    return res.json({ message: `${ids.length} SIM card(s) deleted` });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const importSimCards = async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No rows to import' });
    }
    const valid = [];
    const invalid = [];
    const usedMobile = new Set();
    for (const raw of rows) {
      const row = clean(raw);
      const missing = requiredFields.filter((f) => !row[f] || !String(row[f]).trim());
      const dup = row.mobile_id ? usedMobile.has(String(row.mobile_id).trim()) : false;
      if (dup) usedMobile.add(String(row.mobile_id).trim());
      if (missing.length > 0 || dup) {
        invalid.push({ row, reason: missing.length ? `Missing: ${missing.join(', ')}` : 'Duplicate Mobile ID' });
        continue;
      }
      if (row.mobile_id) usedMobile.add(String(row.mobile_id).trim());
      const { daysLeft, dcStatus } = computeExpiry(row.expiry_date);
      row.status = row.status && SIM_STATUSES.includes(row.status) ? row.status : (row.status || 'Active');
      if (!row.status || !SIM_STATUSES.includes(row.status)) {
        row.status = finalStatus({ status: row.status || 'Active' }, { daysLeft, dcStatus });
      }
      row.replacement_count = Number(row.replacement_count) || 0;
      row.created_by = req.user?.login_id || req.user?.name || null;
      valid.push(row);
    }
    const inserted = valid.length ? await bulkInsertSimCards(valid) : [];
    return res.status(201).json({
      message: `Imported ${inserted.length} SIM card(s)`,
      valid: inserted.length,
      invalid: invalid.length,
      invalidRows: invalid,
      inserted: (inserted || []).map((r) => r.id).filter(Boolean),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
