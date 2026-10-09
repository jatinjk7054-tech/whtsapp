import db, { sql } from '../config/db.js';
import { maybeRefreshSpecialIncentives } from '../services/specialIncentiveService.js';

// Keep the id sequence ahead of the highest existing id before inserting, so a
// default-sequence insert never collides with a row that was written earlier
// with an explicit id (e.g. a data migration/import that didn't reset the
// sequence). This prevents "duplicate key value violates unique constraint
// fro_donor_logs_pkey". Runs inside a single statement so it is atomic; if it
// ever fails it is non-fatal (best-effort) and the insert still proceeds.
export const ensureLogSequenceHealth = async () => {
  try {
    await sql(`
      SELECT setval('fro_donor_logs_id_seq',
             GREATEST((SELECT COALESCE(MAX(id), 0) FROM fro_donor_logs),
                      (SELECT last_value FROM fro_donor_logs_id_seq)),
             true)
    `);
  } catch (e) {
    console.error('fro_donor_logs sequence resync failed:', e.message);
  }
};

export const createDonorLog = async (data) => {
  await ensureLogSequenceHealth();
  const { data: result, error } = await db
    .from('fro_donor_logs')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  maybeRefreshSpecialIncentives().catch(() => {});
  return result;
};

// Find a same-day disposition log for the same assignment + worker + detail so
// repeat saves (e.g. re-dialing a ringing/busy donor) refresh the existing row
// instead of piling up identical timeline entries.
export const findDispositionLogToday = async (assignmentId, workerId, detail, dayStart) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('id')
    .eq('assignment_id', assignmentId)
    .eq('fro_worker_id', workerId)
    .eq('action', 'disposition')
    .eq('disposition_detail', detail)
    .gte('created_at', dayStart)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0] : null;
};

export const updateDonorLog = async (id, updates) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  maybeRefreshSpecialIncentives().catch(() => {});
  return data;
};

export const findLogsByAssignment = async (assignmentId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('*')
    .eq('assignment_id', assignmentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

// OR-groups matching a collection on its ACTUAL collection date, expressed FLAT
// (no or() nested inside and()) so the custom query builder's or()-parser can
// handle it. donations & 'done' logs count on created_at OR transaction_datetime;
// verified 'lead_done' logs count on verified_at.
export const COLLECTION_DATE_OR = (s, e) =>
  `and(action.eq.donation,created_at.gte.${s},created_at.lte.${e}),` +
  `and(action.eq.donation,transaction_datetime.gte.${s},transaction_datetime.lte.${e}),` +
  `and(disposition_detail.eq.done,action.eq.disposition,created_at.gte.${s},created_at.lte.${e}),` +
  `and(disposition_detail.eq.done,action.eq.disposition,transaction_datetime.gte.${s},transaction_datetime.lte.${e}),` +
  `and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified,verified_at.gte.${s},verified_at.lte.${e})`;

const dayKey = (iso) => (iso ? String(iso).slice(0, 10) : null);

// A log counts as a collection on its ACTUAL transaction date, not its upload date.
// Imported receipts carry the real date in transaction_datetime; verified lead-dones
// are counted on the date they were verified.
export function logCollectionDate(d) {
  if (d.action === 'disposition' && d.disposition_detail === 'lead_done' && d.accounts_status === 'verified') {
    return d.verified_at;
  }
  return d.transaction_datetime || d.created_at;
}

export function inRange(date, start, end) {
  if (!date) return false;
  const dk = dayKey(date);
  return dk >= dayKey(start) && dk <= dayKey(end);
}

// Discriminates genuinely distinct payments that share donor + amount + day + NGO
// (e.g. a donor paying the same amount twice in one day) from duplicate copies of
// the SAME payment (a donation log plus its verified lead_done copy), which always
// carry the same payment reference.
export function paymentDiscriminant(d) {
  const ref = String(d.upi_transaction_id || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  if (ref) return `U${ref}`;
  const rm = /receipt\s+([A-Za-z0-9]+)/i.exec(String(d.remark || ''));
  if (rm) return `R${rm[1]}`;
  return 'X';
}

export const getCollectedByNgo = async (workerId, monthStart, monthEnd, allowedNgoIds) => {
  const { data: worker } = await db.from('workers').select('name').eq('id', workerId).maybeSingle();
  if (!worker?.name) return {};
  const workerName = worker.name.trim();

const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);
  const { data: receipts, error } = await sql(
    `SELECT id, donor_id, amount, project_id, receipt_date, receipt_no, payment_id, agent_name, log_id
     FROM receipts
     WHERE receipt_date >= $1 AND receipt_date <= $2
       AND lower(btrim(agent_name)) = $3`,
    [monthStartDay, monthEndDay, workerName.toLowerCase()]
  ).then(r => ({ data: r, error: null })).catch(e => ({ data: null, error: e }));
  if (error) throw error;
  // Verified this month but receipt backdated (receipt_date = transaction date,
  // verified_at = now): include via linked log so Verified ⊆ Collected.
  let verifiedReceipts = [];
  try {
    verifiedReceipts = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.project_id, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = $1 AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerId, monthStart, monthEnd]
    );
  } catch (e) { verifiedReceipts = []; }
  for (const r of verifiedReceipts || []) {
    if (!(receipts || []).some(x => String(x.id) === String(r.id))) receipts.push(r);
  }

  const { data: ngos } = await db.from('ngos').select('id, name');
  const projToNgoId = {};
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const n of ngos || []) {
    const nn = norm(n.name);
    projToNgoId[nn] = n.id;
    if (nn.includes('beingsevak') || nn.includes('sevak')) projToNgoId['bsct'] = n.id;
    if (nn.includes('ashray')) projToNgoId['aflf'] = n.id;
    if (nn.includes('mann')) projToNgoId['mann'] = n.id;
  }

  const byNgo = {};
  const seen = new Set();
  for (const r of receipts || []) {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) continue;
    const dedupKey = `${r.receipt_no || ''}|${r.donor_id || ''}|${amount}|${r.receipt_date || ''}|${r.payment_id || ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const projectNorm = norm(r.project_id);
    const ngoId = projToNgoId[projectNorm] || r.project_id || 'others';
    const key = (allowedNgoIds && allowedNgoIds.length > 0 && allowedNgoIds.includes(ngoId)) ? ngoId : (ngoId || 'others');
    byNgo[key] = (byNgo[key] || 0) + amount;
  }
  return byNgo;
};

export const getTotalCollectedByWorker = async (workerId, monthStart, monthEnd) => {
  const { data: worker } = await db.from('workers').select('name').eq('id', workerId).maybeSingle();
  if (!worker?.name) return 0;
  const workerName = worker.name.trim();

  const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);
  const { data: receipts, error } = await db
    .from('receipts')
    .select('id, donor_id, amount, receipt_date, receipt_no, payment_id, agent_name, log_id')
    .ilike('agent_name', workerName)
    .gte('receipt_date', monthStartDay)
    .lte('receipt_date', monthEndDay);
  if (error) throw error;

  // Include receipts verified in this window even when receipt_date (transaction
  // date) falls in an earlier month. Verified card counts by verified_at, so
  // without this Verified amount never lands in Collected. Attributed by the
  // linked log's fro_worker_id (authoritative) instead of agent_name text.
  let verifiedReceipts = [];
  try {
    verifiedReceipts = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = $1 AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerId, monthStart, monthEnd]
    );
  } catch (e) { verifiedReceipts = []; }
  const merged = [...(receipts || [])];
  const ids = new Set(merged.map(r => String(r.id)));
  for (const r of verifiedReceipts || []) {
    if (!ids.has(String(r.id))) { merged.push(r); ids.add(String(r.id)); }
  }

  const seen = new Set();
  let total = 0;
  for (const r of merged) {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) continue;
    const dedupKey = `${r.receipt_no || ''}|${r.donor_id || ''}|${amount}|${r.receipt_date || ''}|${r.payment_id || ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    total += amount;
  }
  return total;
};

export const getDailyCollectionByWorker = async (workerId, monthStart, monthEnd) => {
  const { data: worker } = await db.from('workers').select('name').eq('id', workerId).maybeSingle();
  if (!worker?.name) return {};
  const workerName = worker.name.trim();

  const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);
  const { data: receipts, error } = await db
    .from('receipts')
    .select('id, donor_id, amount, receipt_date, receipt_no, payment_id, agent_name, log_id')
    .ilike('agent_name', workerName)
    .gte('receipt_date', monthStartDay)
    .lte('receipt_date', monthEndDay);
  if (error) throw error;

  // Same verified-in-month union as getTotalCollectedByWorker, bucketed by the
  // verification day so daily AKI days line up with the Verified Today card.
  let verifiedRows = [];
  try {
    verifiedRows = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id,
              l.verified_at AS verified_at
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = $1 AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerId, monthStart, monthEnd]
    );
  } catch (e) { verifiedRows = []; }
  const mergedById = new Map();
  for (const r of receipts || []) mergedById.set(String(r.id), { ...r, verified_at: null });
  // Verified-day version wins when the same receipt appears in both queries.
  for (const r of verifiedRows || []) mergedById.set(String(r.id), r);
  const merged = [...mergedById.values()];

  const seen = new Set();
  const byDay = {};
  for (const r of merged) {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) continue;
    const vDay = r.verified_at ? String(r.verified_at).slice(0, 10) : null;
    const rDay = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    const day = (vDay && vDay >= monthStartDay && vDay <= monthEndDay) ? vDay : rDay;
    if (!day) continue;
    const dedupKey = `${r.receipt_no || ''}|${r.donor_id || ''}|${amount}|${day}|${r.payment_id || ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    byDay[day] = (byDay[day] || 0) + amount;
  }
  return byDay;
};

export const getBatchCollectionStats = async (workerIds, monthStart, monthEnd, todayStart, todayEnd, ngoIds) => {
  if (workerIds.length === 0) {
    const zero = {};
    for (const id of workerIds) zero[id] = 0;
    const zeroV = {};
    for (const id of workerIds) zeroV[id] = { amount: 0, count: 0 };
    return { monthCollection: zero, todayCollection: zero, weekCollection: zero, verifiedMonth: zeroV, unverifiedMonth: zeroV, verifiedToday: zeroV, unverifiedToday: zeroV };
  }

  const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
  const workerNames = (workers || []).filter(w => w.name).map(w => ({ id: w.id, name: w.name.trim() }));

  const monthStartDay = String(monthStart).slice(0, 10);
  const monthEndDay = String(monthEnd).slice(0, 10);
  const todayStartDay = String(todayStart).slice(0, 10);
  const todayEndDay = String(todayEnd).slice(0, 10);

  const init = () => ({ amount: 0, count: 0 });
  const monthCollection = {}; for (const id of workerIds) monthCollection[id] = 0;
  const todayCollection = {}; for (const id of workerIds) todayCollection[id] = 0;
  const weekCollection = {}; for (const id of workerIds) weekCollection[id] = 0;
  const verifiedMonth = {}; for (const id of workerIds) verifiedMonth[id] = init();
  const unverifiedMonth = {}; for (const id of workerIds) unverifiedMonth[id] = init();
  const verifiedToday = {}; for (const id of workerIds) verifiedToday[id] = init();
  const unverifiedToday = {}; for (const id of workerIds) unverifiedToday[id] = init();

  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6); weekEnd.setHours(23, 59, 59, 999);
  const weekStartDay = weekStart.toISOString().slice(0, 10);
  const weekEndDay = weekEnd.toISOString().slice(0, 10);

  if (workerNames.length === 0) {
    return { monthCollection, todayCollection, weekCollection, verifiedMonth, unverifiedMonth, verifiedToday, unverifiedToday };
  }

  const byName = {};
  for (const w of workerNames) {
    const k = w.name.toLowerCase();
    (byName[k] = byName[k] || []).push(w.id);
  }

  const receipts = await sql(
    `SELECT id, donor_id, amount, project_id, receipt_date, receipt_no, payment_id, agent_name, log_id
     FROM receipts
     WHERE receipt_date >= $1 AND receipt_date <= $2
       AND lower(btrim(agent_name)) = ANY($3)`,
    [monthStartDay, monthEndDay, Object.keys(byName)]
  );

  // Receipts verified in-month but backdated to an earlier receipt_date.
  // Attributed by linked log worker so Verified ⊆ Collected per worker.
  let verifiedLinked = [];
  try {
    verifiedLinked = await sql(
      `SELECT r.id, r.donor_id, r.amount, r.project_id, r.receipt_date, r.receipt_no, r.payment_id, r.agent_name, r.log_id,
              l.fro_worker_id AS log_worker_id, l.verified_at AS verified_at
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = ANY($1) AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerIds, monthStart, monthEnd]
    );
  } catch (e) { verifiedLinked = []; }

  const dedup = {}; for (const id of workerIds) dedup[id] = new Set();
  const verifiedLinkedIds = new Set((verifiedLinked || []).map(r => `${r.log_worker_id}|${String(r.id)}`));
  const applyReceipt = (id, r, day) => {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0 || !day) return;
    const idKey = String(r.id);
    if (dedup[id].has(idKey)) return;
    dedup[id].add(idKey);
    if (day >= monthStartDay && day <= monthEndDay) monthCollection[id] += amount;
    if (day >= weekStartDay && day <= weekEndDay) weekCollection[id] += amount;
    if (day >= todayStartDay && day <= todayEndDay) todayCollection[id] += amount;
    if (day >= monthStartDay && day <= monthEndDay) {
      verifiedMonth[id].amount += amount;
      verifiedMonth[id].count++;
    }
    if (day >= todayStartDay && day <= todayEndDay) {
      verifiedToday[id].amount += amount;
      verifiedToday[id].count++;
    }
  };

  for (const r of receipts) {
    // Skip linked receipts here when the linked log belongs to a known worker;
    // they are attributed via verifiedLinked to avoid agent_name mismatches.
    if (r.log_id) continue;
    const matched = byName[String(r.agent_name || '').trim().toLowerCase()];
    if (!matched) continue;
    const day = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    for (const id of matched) applyReceipt(id, r, day);
  }
  for (const r of receipts) {
    if (!r.log_id) continue;
    const matched = byName[String(r.agent_name || '').trim().toLowerCase()];
    if (!matched) continue;
    const day = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    for (const id of matched) {
      // Verified-day bucket below wins for the same receipt+worker; skip here
      // to avoid counting one receipt twice on two different days.
      if (verifiedLinkedIds.has(`${id}|${String(r.id)}`)) continue;
      applyReceipt(id, r, day);
    }
  }
  for (const r of verifiedLinked || []) {
    const id = r.log_worker_id;
    if (!id || !dedup[id]) continue;
    const vDay = r.verified_at ? String(r.verified_at).slice(0, 10) : null;
    const day = (vDay && vDay >= monthStartDay && vDay <= monthEndDay)
      ? vDay
      : (r.receipt_date ? String(r.receipt_date).slice(0, 10) : null);
    applyReceipt(id, r, day);
  }

  // Unverified = pending lead_done logs (receipts only exist after verify, so
  // the receipts loop above can never fill these — previously always zero).
  try {
    const pending = await sql(
      `SELECT fro_worker_id, amount_collected, created_at
       FROM fro_donor_logs
       WHERE fro_worker_id = ANY($1) AND disposition_detail = 'lead_done' AND accounts_status = 'pending'
         AND created_at >= $2 AND created_at <= $3`,
      [workerIds, monthStart, monthEnd]
    );
    for (const l of pending || []) {
      const id = l.fro_worker_id;
      if (!id || !unverifiedMonth[id]) continue;
      const amount = parseFloat(l.amount_collected || 0);
      const day = l.created_at ? String(l.created_at).slice(0, 10) : null;
      unverifiedMonth[id].amount += amount;
      unverifiedMonth[id].count++;
      if (day && day >= todayStartDay && day <= todayEndDay) {
        unverifiedToday[id].amount += amount;
        unverifiedToday[id].count++;
      }
    }
  } catch (e) { /* keep zeros on failure */ }

  return { monthCollection, todayCollection, weekCollection, verifiedMonth, unverifiedMonth, verifiedToday, unverifiedToday };
};

// Verified collection credited to each worker (by receipts.agent_name) within an
// arbitrary inclusive day range. Mirrors the month/today receipt matching used by
// getBatchCollectionStats but lets the dashboard compute period performance
// (yesterday / this week / this month / a custom range) instead of only today.
export const getRangeCollectionByWorker = async (workerIds, startDay, endDay) => {
  const result = {};
  for (const id of workerIds) result[id] = 0;
  if (workerIds.length === 0) return result;

  const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
  const byName = {};
  for (const w of workers || []) {
    if (!w.name) continue;
    const k = w.name.trim().toLowerCase();
    (byName[k] = byName[k] || []).push(w.id);
  }
  if (Object.keys(byName).length === 0) return result;

  const receipts = await sql(
    `SELECT id, amount, receipt_date, receipt_no, donor_id, payment_id, agent_name, log_id
     FROM receipts
     WHERE receipt_date >= $1 AND receipt_date <= $2
       AND lower(btrim(agent_name)) = ANY($3)`,
    [startDay, endDay, Object.keys(byName)]
  );
  let verifiedLinked = [];
  try {
    verifiedLinked = await sql(
      `SELECT r.id, r.amount, r.receipt_date, r.receipt_no, r.donor_id, r.payment_id, r.agent_name, r.log_id,
              l.fro_worker_id AS log_worker_id
       FROM receipts r
       JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE l.fro_worker_id = ANY($1) AND l.accounts_status = 'verified'
         AND l.verified_at >= $2 AND l.verified_at <= $3`,
      [workerIds, startDay, endDay]
    );
  } catch (e) { verifiedLinked = []; }

  const dedup = {};
  for (const id of workerIds) dedup[id] = new Set();
  const addAmt = (id, r) => {
    const amount = parseFloat(r.amount || 0);
    if (amount <= 0) return;
    const idKey = String(r.id);
    if (dedup[id].has(idKey)) return;
    dedup[id].add(idKey);
    result[id] += amount;
  };
  for (const r of receipts) {
    const matched = byName[String(r.agent_name || '').trim().toLowerCase()];
    if (!matched) continue;
    const day = r.receipt_date ? String(r.receipt_date).slice(0, 10) : null;
    if (!day) continue;
    for (const id of matched) addAmt(id, r);
  }
  for (const r of verifiedLinked || []) {
    if (r.log_worker_id && dedup[r.log_worker_id]) addAmt(r.log_worker_id, r);
  }
  return result;
};

export const findLogsByDonorAndWorker = async (donorId, workerId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('*')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('findLogsByDonorAndWorker query failed, trying fallback:', error.message);
    const { data: assignment, error: asgnErr } = await db
      .from('fro_assignments')
      .select('id')
      .eq('donor_id', donorId)
      .eq('fro_worker_id', workerId)
      .not('status', 'eq', 'reassigned')
      .maybeSingle();
    if (asgnErr) {
      console.error('findLogsByDonorAndWorker fallback also failed:', asgnErr.message);
      throw asgnErr;
    }
    if (assignment) {
      return findLogsByAssignment(assignment.id);
    }
    return [];
  }
  return data || [];
};

export const getTotalCollectedByDonorAndWorker = async (donorId, workerId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('amount_collected')
    .eq('donor_id', donorId)
    .eq('fro_worker_id', workerId)
    .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)');
  if (error) {
    console.error('getTotalCollectedByDonorAndWorker failed, trying fallback:', error.message);
    const { data: assignment, error: asgnErr } = await db
      .from('fro_assignments')
      .select('id')
      .eq('donor_id', donorId)
      .eq('fro_worker_id', workerId)
      .not('status', 'eq', 'reassigned')
      .maybeSingle();
    if (asgnErr) {
      console.error('getTotalCollectedByDonorAndWorker fallback also failed:', asgnErr.message);
      throw asgnErr;
    }
    if (assignment) {
      return getTotalCollectedByAssignment(assignment.id);
    }
    return 0;
  }
  let total = 0;
  for (const d of data || []) {
    total += parseFloat(d.amount_collected || 0);
  }
  return total;
};

export const getVerifiedCollection = async (workerId, startDate, endDate) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('amount_collected, fro_worker_id')
    .eq('fro_worker_id', workerId)
    .eq('disposition_detail', 'lead_done')
    .eq('accounts_status', 'verified')
    .gte('verified_at', startDate)
    .lte('verified_at', endDate);
  if (error) throw error;

  let total = 0;
  for (const d of data || []) total += parseFloat(d.amount_collected || 0);
  return { amount: total, count: (data || []).length };
};

export const getUnverifiedCollection = async (workerId, startDate, endDate) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('amount_collected, fro_worker_id')
    .eq('fro_worker_id', workerId)
    .eq('disposition_detail', 'lead_done')
    .eq('accounts_status', 'pending')
    .gte('created_at', startDate)
    .lte('created_at', endDate);
  if (error) throw error;

  let total = 0;
  for (const d of data || []) total += parseFloat(d.amount_collected || 0);
  return { amount: total, count: (data || []).length };
};

export const getTotalCollectedByAssignment = async (assignmentId) => {
  const { data, error } = await db
    .from('fro_donor_logs')
    .select('amount_collected, action, disposition_detail')
    .eq('assignment_id', assignmentId)
    .or('action.eq.donation,and(disposition_detail.eq.lead_done,action.eq.disposition,accounts_status.eq.verified),and(disposition_detail.eq.done,action.eq.disposition)');
  if (error) throw error;

  let total = 0;
  for (const d of data) {
    total += parseFloat(d.amount_collected || 0);
  }
  return total;
};
