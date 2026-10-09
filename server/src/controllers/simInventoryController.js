import {
  createInventoryItem,
  getAllInventoryItems,
  getInventoryItemById,
  updateInventoryItem,
  deleteInventoryItem,
  bulkInsertInventoryItems,
} from '../models/simInventoryModel.js';
import { getAllSimCards, updateSimCard, createSimCardHistory } from '../models/simCardModel.js';

export const INVENTORY_STATUSES = ['Available', 'Assigned', 'Expired', 'Lost', 'Damaged', 'Inactive'];

/* A SIM is valid for 28 days from the day it is issued, so a SIM issued on
   21-09-2026 expires on 19-10-2026. The Add form sends the derived date, but the
   rule is applied here too so imports and direct API calls land on the same
   expiry instead of a spare with no expiry at all. */
export const SIM_VALIDITY_DAYS = 28;

/* Every column the Locker is allowed to write.
 *
 * The Add form's "Owner Name" input is named owner_name but is stored in the
 * assigned_to column, and the payload used to be built with a `...form` spread,
 * so owner_name rode along next to the assigned_to it had been mapped into.
 * PostgREST rejects the ENTIRE statement when any key is not a real column, so
 * every Add to the Locker failed with
 *   {"message":"column \"owner_name\" of relation \"sim_inventory\" does not exist"}
 * and nothing saved. migrations/154 completes the table, and this list means any
 * future stray field is dropped instead of taking the whole save down.
 *
 * The key set is fixed rather than derived from the request body on purpose: a
 * bulk insert requires every object to carry identical keys, so an imported row
 * that omits `location` would otherwise disagree with a row that includes it. */
const writableFields = [
  'sim_name', 'sim_number', 'sim_type', 'provider', 'status', 'location',
  'mobile_id', 'device', 'imei', 'assigned_to', 'team',
  'assignment_date', 'issue_date', 'expiry_date', 'notes', 'created_by',
];

const dateFields = new Set(['assignment_date', 'issue_date', 'expiry_date']);

function clean(data) {
  const src = data || {};
  const c = {};
  writableFields.forEach((k) => {
    const v = src[k];
    if (v === undefined || v === null || v === '') c[k] = null;
    else if (dateFields.has(k)) c[k] = String(v).slice(0, 10);
    else c[k] = v;
  });
  if (!c.status || !INVENTORY_STATUSES.includes(c.status)) c.status = 'Available';
  return c;
}

/* Calendar-day arithmetic rather than milliseconds: adding 86400000 drifts by an
   hour across a DST boundary and can land on the previous day. setDate() keeps
   the local calendar date exact. */
export function addDaysStr(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function autoExpiryDate(issueDate, validityDays = SIM_VALIDITY_DAYS) {
  return addDaysStr(issueDate, validityDays);
}

/* Fills in the expiry of a row that has an issue date but never got one. An
   expiry that is already stored is left alone, so a SIM with a different validity
   window (a custom recharge, say) is not silently rewritten. */
function applyAutoExpiry(row) {
  if (row.issue_date && !row.expiry_date) {
    row.expiry_date = autoExpiryDate(row.issue_date);
  }
  return row;
}

function computeExpiry(expiryDate, today = new Date()) {
  if (!expiryDate) return { days_left: null, derived_status: 'Inactive' };
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const end = new Date(`${expiryDate}T00:00:00`).getTime();
  const days = Math.round((end - start) / 86400000);
  /* days === 0 means today IS the expiry date, so the SIM is still good for the
     whole of today and only turns Expired the day after. Treating 0 as Expired
     (days >= 1) cut a SIM's life one day short: one issued 21-09-2026 expired on
     19-10-2026 rather than 20-10, so it was marked Expired while the Locker
     still showed "Today" days left. */
  if (days > 30) return { days_left: days, derived_status: 'Active' };
  if (days >= 0) return { days_left: days, derived_status: 'Expiring Soon' };
  return { days_left: days, derived_status: 'Expired' };
}

/* Only the INVENTORY_STATUSES vocabulary may leave this function. computeExpiry
   speaks the sim_cards language ('Active' / 'Expiring Soon'), which is not valid
   for a stock row, so a spare SIM with no expiry date must stay 'Available'
   instead of being downgraded to 'Inactive' or labelled 'Active'. */
function finalStatus(item, derived) {
  const base = (item.status || 'Available').trim();
  if (INVENTORY_STATUSES.includes(base)) {
    if (['Lost', 'Damaged', 'Inactive'].includes(base)) return base;
    if (base === 'Assigned') return 'Assigned';
    if (base === 'Expired' || derived.derived_status === 'Expired') return 'Expired';
    return 'Available';
  }
  /* A row still carrying the sim_cards vocabulary ('Active' / 'Expiring Soon')
     from the old status bug. Infer the truth from whether a phone is recorded,
     so the Locker stays correct even if the boot-time repair could not run. */
  if (String(item.mobile_id || '').trim()) return 'Assigned';
  return derived.derived_status === 'Expired' ? 'Expired' : 'Available';
}

/* ── Locker → All SIM Cards sync ─────────────────────────────────────────────
 *
 * The Locker (sim_inventory) and the "All SIM Cards" table (sim_cards) are two
 * different tables: assigning a SIM used to write only sim_inventory, so the
 * number never showed up on the mobile's row in SIM Management → All SIM
 * Cards. These helpers keep them in step:
 *
 *   assign  → the locker's SIM number is written into the first free sim_N
 *             slot of the mobile's sim_cards row (sim_1..sim_20),
 *   release → that number is cleared from every sim_cards row,
 *   edit/delete → same rules follow the changed mobile_id / sim_number.
 *
 * Every slot write goes through writeCardPatch() so it also lands in
 * sim_card_history, exactly like a manual edit of the same slot. A history or
 * sync failure never fails the Locker operation itself - it surfaces as a
 * warning message instead. */
const MAX_SIM_SLOTS = 20;
/* Empty slot markers used by imports and manual entry: they mean "nothing
   here", so a locker SIM may take the slot. Compared case-insensitively. */
const EMPTY_SLOT_VALUES = new Set(['', '-', 'na', 'n/a', 'no sim', 'none']);

const slotKey = (n) => `sim_${n}`;
const slotText = (v) => (v === null || v === undefined ? '' : String(v).trim());
const slotIsEmpty = (v) => EMPTY_SLOT_VALUES.has(slotText(v).toLowerCase());
const sameNumber = (a, b) => {
  const x = slotText(a).toLowerCase();
  return x !== '' && x === slotText(b).toLowerCase();
};

function freeSlotOf(card) {
  for (let n = 1; n <= MAX_SIM_SLOTS; n++) if (slotIsEmpty(card[slotKey(n)])) return n;
  return null;
}

function slotsHolding(card, simNumber) {
  const held = [];
  for (let n = 1; n <= MAX_SIM_SLOTS; n++) if (sameNumber(card[slotKey(n)], simNumber)) held.push(n);
  return held;
}

/* Which sim_cards row belongs to a mobile_id. Android phones show the numbers
   merged from their "android whatsapp N" card (see the enriched merge in
   Inventory.jsx) - that card is where the numbers are read from, so it is the
   one that must receive a newly assigned SIM, and the phone's own row is only
   the fallback when there is no WhatsApp twin. */
function findCardByMobile(cards, mobileId) {
  const mid = slotText(mobileId).toLowerCase();
  if (!mid) return null;
  const m = mid.match(/^android\s+(\d+)$/);
  if (m) {
    const wa = cards.find((c) => slotText(c.mobile_id).toLowerCase() === `android whatsapp ${m[1]}`);
    if (wa) return wa;
  }
  return cards.find((c) => slotText(c.mobile_id).toLowerCase() === mid) || null;
}

async function writeCardPatch(card, patch, changedBy) {
  const changedCols = {};
  Object.entries(patch).forEach(([k, v]) => {
    const prev = card[k] ?? null;
    const next = v ?? null;
    if (String(prev) !== String(next)) changedCols[k] = { old: prev, new: next };
  });
  if (!Object.keys(changedCols).length) return card;
  const updated = await updateSimCard(card.id, patch);
  try {
    await createSimCardHistory({
      sim_card_id: card.id,
      changed_by: changedBy,
      changed_cols: changedCols,
      before_data: card,
      after_data: { ...card, ...patch },
    });
  } catch {
    /* history is an audit trail, never a blocker */
  }
  return updated;
}

async function unlinkNumber(simNumber, changedBy) {
  const num = slotText(simNumber);
  if (!num) return;
  let cards;
  try {
    cards = await getAllSimCards();
  } catch {
    return;
  }
  for (const card of cards) {
    const held = slotsHolding(card, num);
    if (!held.length) continue;
    const patch = {};
    held.forEach((n) => { patch[slotKey(n)] = null; });
    try {
      await writeCardPatch(card, patch, changedBy);
    } catch {
      /* keep going: one broken row must not strand the rest */
    }
  }
}

/* Returns a warning string when the number could not be shown in All SIM
   Cards, or null when the mobile's row now carries it. */
async function linkNumberToMobile(simNumber, mobileId, changedBy) {
  const num = slotText(simNumber);
  if (!num) return null;
  let cards;
  try {
    cards = await getAllSimCards();
  } catch (e) {
    return `SIM assigned, but All SIM Cards could not be refreshed (${e.message})`;
  }
  const target = findCardByMobile(cards, mobileId);
  /* The number may still sit on the row of a previously assigned phone. */
  for (const card of cards) {
    if (target && card.id === target.id) continue;
    const held = slotsHolding(card, num);
    if (!held.length) continue;
    const patch = {};
    held.forEach((n) => { patch[slotKey(n)] = null; });
    try {
      await writeCardPatch(card, patch, changedBy);
    } catch {
      /* ignore, the link below still runs */
    }
  }
  if (!target) {
    return `SIM assigned, but no SIM Card row matches Mobile ID "${slotText(mobileId)}" - the number will not appear in All SIM Cards.`;
  }
  if (slotsHolding(target, num).length) return null;
  const slot = freeSlotOf(target);
  if (!slot) {
    return `SIM assigned, but ${slotText(mobileId)} has no free SIM slot (sim_1..sim_20) - the number will not appear in All SIM Cards.`;
  }
  try {
    await writeCardPatch(target, { [slotKey(slot)]: num }, changedBy);
    return null;
  } catch (e) {
    return `SIM assigned, but the number could not be written to All SIM Cards (${e.message})`;
  }
}

const changedByOf = (req) => req.user?.login_id || req.user?.name || req.user?.id || null;

/* Best-effort sync wrapped so a sim_cards hiccup can never fail the Locker
   call itself - the caller turns a thrown error into a warning message. */
async function syncWarn(fn) {
  try {
    return await fn();
  } catch (e) {
    return `Sim Cards sync failed (${e.message})`;
  }
}

export const addInventoryItem = async (req, res) => {
  try {
    const body = clean(req.body);
    if (!body.sim_number || !String(body.sim_number).trim()) {
      return res.status(400).json({ message: 'SIM Number is required' });
    }
    const derived = computeExpiry(applyAutoExpiry(body).expiry_date);
    body.status = finalStatus({ status: body.status }, derived);
    body.created_by = req.user?.login_id || req.user?.id || req.user?.name || null;
    const item = await createInventoryItem(body);
    return res.status(201).json({ message: 'SIM added to inventory', item, days_left: derived.days_left });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'SIM Number already exists in inventory' });
    }
    return res.status(500).json({ message: error.message });
  }
};

export const listInventoryItems = async (req, res) => {
  try {
    const items = await getAllInventoryItems();
    const now = new Date();
    const withMeta = items.map((raw) => {
      const it = applyAutoExpiry({ ...raw });
      const derived = computeExpiry(it.expiry_date, now);
      const status = finalStatus(it, derived);
      return { ...it, status, days_left: derived.days_left, derived_status: status };
    });
    return res.json(withMeta);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getInventoryItem = async (req, res) => {
  try {
    const item = await getInventoryItemById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Inventory item not found' });
    const withExpiry = applyAutoExpiry({ ...item });
    const derived = computeExpiry(withExpiry.expiry_date);
    return res.json({ ...withExpiry, days_left: derived.days_left, derived_status: finalStatus(withExpiry, derived) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editInventoryItem = async (req, res) => {
  try {
    const body = clean(req.body);
    if (!body.sim_number || !String(body.sim_number).trim()) {
      return res.status(400).json({ message: 'SIM Number is required' });
    }
    const derived = computeExpiry(applyAutoExpiry(body).expiry_date);
    body.status = finalStatus({ status: body.status }, derived);
    const before = await getInventoryItemById(req.params.id);
    if (!before) return res.status(404).json({ message: 'Inventory item not found' });
    const item = await updateInventoryItem(req.params.id, body);
    /* Keep the mobile's sim_cards row in step with the edit: a new number
       replaces the old one, a changed/cleared mobile_id moves or removes it. */
    const changedBy = changedByOf(req);
    const oldNum = slotText(before.sim_number);
    const newNum = slotText(item.sim_number);
    const beforePhone = slotText(before.mobile_id);
    const afterPhone = slotText(item.mobile_id);
    let warning = null;
    if (oldNum && !sameNumber(oldNum, newNum)) {
      await syncWarn(() => unlinkNumber(oldNum, changedBy));
    }
    if (beforePhone !== afterPhone && beforePhone) {
      await syncWarn(() => unlinkNumber(newNum || oldNum, changedBy));
    }
    if (afterPhone && newNum) {
      warning = await syncWarn(() => linkNumberToMobile(newNum, afterPhone, changedBy));
    }
    return res.json({ message: 'Inventory item updated', item, days_left: derived.days_left, warning });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'SIM Number already exists in inventory' });
    }
    return res.status(500).json({ message: error.message });
  }
};

export const removeInventoryItem = async (req, res) => {
  try {
    const before = await getInventoryItemById(req.params.id);
    /* Deleting an assigned SIM must not leave its number behind on the
       mobile's row in All SIM Cards. */
    if (before && slotText(before.mobile_id) && slotText(before.sim_number)) {
      await syncWarn(() => unlinkNumber(before.sim_number, changedByOf(req)));
    }
    await deleteInventoryItem(req.params.id);
    return res.json({ message: 'Inventory item deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const assignInventoryItem = async (req, res) => {
  try {
    const item = await getInventoryItemById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Inventory item not found' });
    const { mobile_id, device, imei, assigned_to, team, assignment_date } = req.body;
    if (!mobile_id || !String(mobile_id).trim()) {
      return res.status(400).json({ message: 'Mobile ID No. is required' });
    }
    const updated = await updateInventoryItem(req.params.id, {
      mobile_id: String(mobile_id).trim(),
      device: device || item.device || null,
      imei: imei || item.imei || null,
      assigned_to: assigned_to || item.assigned_to || null,
      team: team || item.team || null,
      assignment_date: assignment_date || new Date().toISOString().slice(0, 10),
      status: 'Assigned',
    });
    /* The Locker row alone is not enough: All SIM Cards reads sim_cards, so
       the number has to be written onto the mobile's row as well. */
    const warning = await syncWarn(() => linkNumberToMobile(
      updated.sim_number, updated.mobile_id, changedByOf(req),
    ));
    return res.json({ message: 'SIM assigned', item: updated, warning });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !INVENTORY_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    /* Moving a SIM out of 'Assigned' releases it back to the locker, so the
       phone it was sitting on has to be cleared as well. Otherwise a released
       SIM would still display a Mobile ID while counting as unassigned.
       `assigned_to` is deliberately left alone: it holds the SIM's owner name,
       which belongs to the SIM itself and survives a release. */
    const updates = { status };
    const before = await getInventoryItemById(req.params.id);
    if (!before) return res.status(404).json({ message: 'Inventory item not found' });
    if (status !== 'Assigned') {
      Object.assign(updates, {
        mobile_id: null,
        device: null,
        imei: null,
        assignment_date: null,
      });
    }
    const item = await updateInventoryItem(req.params.id, updates);
    /* A SIM handed back to the locker must also leave the mobile's row in
       All SIM Cards, otherwise a released number keeps showing on the phone. */
    if (status !== 'Assigned' && slotText(before.mobile_id) && slotText(before.sim_number)) {
      await syncWarn(() => unlinkNumber(before.sim_number, changedByOf(req)));
    }
    const derived = computeExpiry(applyAutoExpiry({ ...item }).expiry_date);
    return res.json({ message: 'Status updated', item: { ...item, status, ...derived } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteBulk = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No items selected' });
    }
    for (const id of ids) {
      const before = await getInventoryItemById(id);
      if (before && slotText(before.mobile_id) && slotText(before.sim_number)) {
        await syncWarn(() => unlinkNumber(before.sim_number, changedByOf(req)));
      }
      await deleteInventoryItem(id);
    }
    return res.json({ message: `${ids.length} item(s) deleted` });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const importInventoryItems = async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No rows to import' });
    }
    const valid = [];
    const invalid = [];
    const used = new Set();
    for (const raw of rows) {
      const row = clean(raw);
      const missing = !row.sim_number || !String(row.sim_number).trim();
      const dup = row.sim_number ? used.has(String(row.sim_number).trim()) : true;
      if (row.sim_number) used.add(String(row.sim_number).trim());
      if (missing || dup) {
        invalid.push({ row, reason: missing ? 'Missing SIM Number' : 'Duplicate SIM Number' });
        continue;
      }
      const derived = computeExpiry(applyAutoExpiry(row).expiry_date);
      row.status = finalStatus({ status: row.status }, derived);
      row.created_by = req.user?.login_id || req.user?.name || null;
      valid.push(row);
    }
    const inserted = valid.length ? await bulkInsertInventoryItems(valid) : [];
    return res.status(201).json({
      message: `Imported ${inserted.length} item(s)`,
      valid: inserted.length,
      invalid: invalid.length,
      invalidRows: invalid,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
