import db from '../config/db.js';

// Suspense receipts: any receipt that is unlinked (donor_id null), unclaimed
// (log_id null), and is "truly suspense" — BOTH the agent name AND the donor
// mobile are missing (NULL / '' / 'NA' / 'suspense'). As soon as either the
// agent name (an FRO claim, an import FSE name, or an Accounts assignment) or a
// donor mobile is attached, the money is identifiable and leaves the Accounts
// suspense pool (the FRO pool still lists it for claiming). Receipts whose
// agent is Priyank Shah are never suspense — they are treated as known
// donations even when no donor/log is linked yet.
export const isPriyankShahAgent = (name) => !!(name && name.trim().toLowerCase() === 'priyank shah');

// A field value counts as "missing" for the suspense rule when it is NULL,
// empty, 'NA', or the 'Suspense' marker (case-insensitive, trimmed).
export const isBlankSuspenseValue = (value) => {
  if (value === null || value === undefined) return true;
  const s = String(value).trim().toLowerCase();
  return s === '' || s === 'na' || s === 'suspense';
};

export const getUnlinkedReceipts = async () => {
  // Receipts already turned into a bank audit entry (a bank_audit_entries row
  // references them via receipt_id) are shown in the list as entries, so they
  // must not also appear in the suspense pool.
  const { rows, error } = await db._pool.query(`
    SELECT r.id, r.receipt_no, r.donor_name, r.donor_mobile, r.amount,
           r.receipt_date, r.receipt_time, r.project_id, r.payment_id, r.agent_name, r.mode, r.bank_name, r.created_at,
           r.pan_number, r.address, r.email, r.verify_type, r.verify_fro_worker_id
    FROM receipts r
    WHERE r.donor_id IS NULL
      AND r.log_id IS NULL
      AND r.receipt_no IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM bank_audit_entries b WHERE b.receipt_id = r.id
      )
    ORDER BY r.receipt_date DESC
  `);
  if (error) throw error;
  return rows || [];
};

// Per-NGO receipt numbers (migration 068). The next receipt number for an NGO
// is the highest number already present for that NGO + 1, so numbering
// continues where each NGO left off. The DB function next_receipt_no() locks
// the per-NGO counter row, so concurrent requests for the same NGO never
// receive the same number; the UNIQUE(project_id, receipt_no) constraint from
// migration 064 is the backstop. Imported receipts carry their own (higher)
// receipt-book numbers, so each allocation also skips past the current per-NGO
// max to avoid colliding with them.
export const getNextReceiptNo = async (projectId) => {
  const { rows } = await db._pool.query('SELECT next_receipt_no($1) AS n', [String(projectId)]);
  return String(rows[0].n);
};

// Lower a project's receipt-number counter back to the highest number still
// present (migration 069), so numbers freed by Go Back / Undo are reused
// instead of being skipped over. Never raises the counter.
export const cancelReceiptNo = async (projectId) => {
  if (!projectId) return;
  await db._pool.query('SELECT cancel_receipt_no($1)', [String(projectId)]);
};

// Admin "clean up" bulk delete. Bypasses the numbered-delete guard (which is
// meant to protect against accidental gaps) because this intentionally wipes a
// whole batch/date range and the counters are reset afterwards. Uses a
// dedicated connection + SET LOCAL so trigger state is never leaked to the pool.
export const bulkDeleteReceipts = async (ids) => {
  if (!ids || ids.length === 0) return 0;
  const idList = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n)).join(',');
  if (!idList) return 0;
  const client = await db._pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const { rowCount } = await client.query(`DELETE FROM receipts WHERE id IN (${idList})`);
    await client.query('COMMIT');
    return rowCount;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// Cancel a receipt WITHOUT losing its number: keep the row + number, stamp it
// voided. The number stays in the book (no gap) and the receipt stops counting.
export const voidReceipt = async (receiptId, reason) => {
  const { data, error } = await db
    .from('receipts')
    .update({ voided_at: new Date().toISOString(), void_reason: reason || null })
    .eq('id', receiptId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Safely remove a receipt: unnumbered rows are hard-deleted; a numbered receipt
// is hard-deleted ONLY if it is the latest number for its project (counter steps
// back, number reused) — otherwise it is voided so the number is never lost.
export const deleteReceiptSafely = async (receiptId, reason) => {
  const { data: r } = await db
    .from('receipts')
    .select('id, receipt_no, project_id')
    .eq('id', receiptId)
    .maybeSingle();
  if (!r) return { gone: true };
  if (!r.receipt_no) {
    await db.from('receipts').delete().eq('id', receiptId);
    return { deleted: true };
  }
  const { rows } = await db._pool.query(
    `SELECT COALESCE(MAX(CASE WHEN receipt_no ~ '^[0-9]+$' THEN receipt_no::bigint END), 0) AS m
     FROM receipts WHERE project_id = $1 AND id <> $2`,
    [r.project_id, receiptId]
  );
  const max = Number((rows && rows[0] && rows[0].m) || 0);
  if (Number(r.receipt_no) >= max) {
    await db.from('receipts').delete().eq('id', receiptId);
    try { await cancelReceiptNo(r.project_id); } catch (_) {}
    return { deleted: true, freed: true };
  }
  await db
    .from('receipts')
    .update({ voided_at: new Date().toISOString(), void_reason: reason || null })
    .eq('id', receiptId);
  return { voided: true };
};

// Read-only receipt-number readout per NGO: the last receipt number issued and
// the next number that will be issued. Mirrors next_receipt_no()'s arithmetic
// (GREATEST(counter, per-NGO max) + 1) WITHOUT advancing the counter, so simply
// viewing the numbers never burns a receipt number. Projects with no receipts
// report last_no = 0 / next_no = 1.
export const getReceiptNumbers = async (projectIds = ['bsct', 'mann', 'aflf']) => {
  const { rows } = await db._pool.query(
    `SELECT project_id,
            COALESCE(MAX(CASE WHEN receipt_no ~ '^[0-9]+$' THEN receipt_no::bigint END), 0) AS max_no
     FROM receipts
     WHERE project_id = ANY($1)
     GROUP BY project_id`,
    [projectIds]
  );

  const { rows: counters } = await db._pool.query(
    `SELECT project_id, last_no
     FROM receipt_no_counters
     WHERE project_id = ANY($1)`,
    [projectIds]
  );

  const maxByProject = new Map(rows.map((r) => [r.project_id, Number(r.max_no) || 0]));
  const counterByProject = new Map(counters.map((c) => [c.project_id, Number(c.last_no) || 0]));

  return projectIds.map((projectId) => {
    const last = Math.max(maxByProject.get(projectId) || 0, counterByProject.get(projectId) || 0);
    return { project_id: projectId, last_no: last, next_no: last + 1 };
  });
};

// NGO name keywords -> canonical project code (receipts.project_id /
// bank_audit_entries.project_id). Mirrors the FRO suspense aliases so a
// donation assigned to any NGO resolves to the project code its receipts are
// numbered under.
const NGO_PROJECT_ALIASES = {
  bsct: ['bsct', 'beingsevak', 'being sevak', 'sevak'],
  mann: ['mann', 'manncar', 'mann care', 'manncare', 'maan'],
  aflf: ['aflf', 'ashray', 'ashray life'],
  library: ['library'],
  pg: ['pg'],
};

// Map any project_id spelling to its canonical NGO code ('bsct' | 'mann' | 'aflf').
// Keeps ONE receipt-number sequence per NGO — alias spellings like 'ashray' or
// 'mann care' would otherwise get their own counter and collide/duplicate.
export const canonicalProject = (projectId) => {
  if (!projectId) return projectId;
  const p = String(projectId).trim().toLowerCase();
  for (const [code, aliases] of Object.entries(NGO_PROJECT_ALIASES)) {
    if (p === code || aliases.some((a) => a === p)) return code;
  }
  return p;
};

// The canonical project code for a lead is the NGO it is assigned under
// (fro_assignments.ngo_id -> ngos.name lowercased). That is authoritative,
// unlike donor_profiles.project_supported which is often unset or stale — a
// missing/wrong project_supported is exactly what made Ashray money take the
// next number from the BSCT sequence. Returns null when the NGO cannot be
// resolved so callers can fall back.
export const projectCodeFromNgoId = async (ngoId) => {
  if (ngoId === null || ngoId === undefined) return null;
  const { data, error } = await db.from('ngos').select('name').eq('id', ngoId).maybeSingle();
  if (error) throw error;
  const name = data?.name ? String(data.name).trim().toLowerCase() : '';
  if (!name) return null;
  for (const [code, aliases] of Object.entries(NGO_PROJECT_ALIASES)) {
    if (name === code || aliases.some((a) => a === name || name.includes(a))) return code;
  }
  return name;
};

// Resolve an NGO's id (ngos.id) from a project code (receipts.project_id /
// bank_audit_entries.project_id, e.g. 'bsct' | 'mann' | 'aflf'). This is the
// inverse of projectCodeFromNgoId — callers that must set fro_assignments.ngo_id
// (NOT NULL) resolve it here from the entry's project_id. Returns null when no
// NGO matches so callers can fall back.
export const ngoIdFromProjectId = async (projectId) => {
  if (!projectId) return null;
  const needle = String(projectId).trim().toLowerCase();
  if (!needle) return null;
  const { data, error } = await db.from('ngos').select('id, name');
  if (error) throw error;
  for (const ngo of data || []) {
    const name = ngo?.name ? String(ngo.name).trim().toLowerCase() : '';
    if (!name) continue;
    if (name === needle) return ngo.id;
    for (const [code, aliases] of Object.entries(NGO_PROJECT_ALIASES)) {
      if (code === needle && (name === code || aliases.some((a) => a === name || name.includes(a)))) {
        return ngo.id;
      }
    }
  }
  return null;
};

export const getSources = async () => {
  const { data, error } = await db
    .from('bank_audit_sources')
    .select('*')
    .order('sort_order');
  if (error) throw error;
  return data || [];
};

export const createSource = async (name, kind = 'bank') => {
  const { data, error } = await db
    .from('bank_audit_sources')
    .insert({ name, kind })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateSource = async (id, updates) => {
  const { data, error } = await db
    .from('bank_audit_sources')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteSource = async (id) => {
  const { error } = await db
    .from('bank_audit_sources')
    .delete()
    .eq('id', id);
  if (error) throw error;
};

export const getEntries = async (filters = {}) => {
  let query = db
    .from('bank_audit_entries')
    .select('*, bank_audit_sources(name), donor_profiles!donor_id(name), receipts!receipt_id(id, receipt_no, log_id, donor_id, agent_name, donor_name, donor_mobile, mode, bank_name, fro_donor_logs!receipts_log_id_fkey(id, amount_collected))')
    .order('transaction_date', { ascending: false })
    .order('payment_time', { ascending: false });

  if (filters.date_from) query = query.gte('transaction_date', filters.date_from);
  if (filters.date_to) query = query.lte('transaction_date', filters.date_to);
  if (filters.source_id) query = query.eq('source_id', filters.source_id);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const createEntry = async (entry) => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .insert(entry)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const updateEntry = async (id, updates) => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const deleteEntry = async (id) => {
  const { error } = await db
    .from('bank_audit_entries')
    .delete()
    .eq('id', id);
  if (error) throw error;
};

export const getSourceSummary = async (filters = {}) => {
  let query = db
    .from('bank_audit_entries')
    .select('source_id, amount, bank_audit_sources!inner(name)');

  if (filters.date_from) query = query.gte('transaction_date', filters.date_from);
  if (filters.date_to) query = query.lte('transaction_date', filters.date_to);

  const { data, error } = await query;
  if (error) throw error;

  const summary = {};
  for (const row of data || []) {
    const name = row.bank_audit_sources?.name || 'Unknown';
    summary[name] = (summary[name] || 0) + Number(row.amount);
  }
  return summary;
};

export const suggestEntries = async (searchTerm) => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .select('id, payment_id, amount, transaction_date, bank_audit_sources(name)')
    .ilike('payment_id', `%${searchTerm}%`)
    .eq('status', 'unverified')
    .order('transaction_date', { ascending: false })
    .limit(10);
  if (error) throw error;
  return data || [];
};

// Bank audit entries an Accounts user can still manually link to a lead:
// unverified and not already matched (auto-suggested, confirmed, or claimed
// via a suspense receipt).
export const getAvailableEntries = async (limit = 200) => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .select('id, payment_id, amount, payer_name, transaction_date, project_id, bank_audit_sources(name), receipts!receipt_id(log_id)')
    .eq('status', 'unverified')
    .is('match_status', null)
    .order('transaction_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || [])
    .filter((r) => !r.receipts?.log_id)
    .map((r) => ({
      id: r.id,
      payment_id: r.payment_id,
      amount: r.amount,
      payer_name: r.payer_name,
      transaction_date: r.transaction_date,
      project_id: r.project_id,
      source: r.bank_audit_sources?.name || '',
    }));
};

// Allocates the next human-readable match number (MTCH-000001, ...) from the
// bank_audit_match_no_seq sequence created by migration 062.
export const nextMatchNo = async () => {
  const { rows } = await db._pool.query("SELECT nextval('bank_audit_match_no_seq') AS n");
  return 'MTCH-' + String(rows[0].n).padStart(6, '0');
};

// Manually link an entry to a lead (matched, source 'manual') without crediting
// anything yet. Accounts later confirms via the bank audit page or the lead's
// verify action. Idempotent when re-saved against the same lead; an existing
// match number is kept so a re-match never renumbers the entry.
export const manualMatchEntry = async (id, logId, actorId) => {
  const { rows } = await db._pool.query('SELECT match_no FROM bank_audit_entries WHERE id = $1', [id]);
  const matchNo = rows[0]?.match_no || (await nextMatchNo());

  // Resolve the linked lead's FRO worker name so the entry's agent name is set
  // (it stays nil otherwise). The matched lead is authoritative for the agent.
  let agentName = null;
  try {
    const { data: leadLogs } = await db
      .from('fro_donor_logs')
      .select('fro_assignments!inner(workers!left(name))')
      .eq('id', logId)
      .limit(1);
    agentName = leadLogs?.[0]?.fro_assignments?.workers?.name || null;
  } catch (err) { console.error('Failed to resolve agent for manual match:', err.message); }

  const { data, error } = await db
    .from('bank_audit_entries')
    .update({
      matched_lead_log_id: logId,
      match_status: 'matched',
      match_source: 'manual',
      matched_by: actorId,
      match_no: matchNo,
      agent_name: agentName,
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, payment_id, amount, matched_lead_log_id, match_status, match_source, match_no, agent_name, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  await syncEntryToLead(id, logId);
  return data;
};

export const syncEntryToLead = async (entryId, logId) => {
  const { data: entry } = await db
    .from('bank_audit_entries')
    .select('payment_id, check_id, transaction_date, payment_time, payer_name')
    .eq('id', entryId)
    .maybeSingle();
  if (!entry) return;

  const { data: lead } = await db
    .from('fro_donor_logs')
    .select('upi_transaction_id, payment_from, transaction_datetime, payment_mode')
    .eq('id', logId)
    .maybeSingle();
  if (!lead) return;

  const patch = {};

  // The audit entry is the source of truth for the money's payment fields: when
  // an entry is matched/claimed to a lead, its values always override the lead's
  // (previously they only filled empty fields, so FRO-entered values won).
  if (entry.payment_id) patch.upi_transaction_id = entry.payment_id;
  if (entry.payer_name) patch.payment_from = entry.payer_name;
  if (entry.transaction_date) {
    const d = String(entry.transaction_date);
    const datePart = d.includes('T') ? d.slice(0, 10) : d;
    // Bank payment times are IST wall-clock; persist with the explicit offset
    // so the stored timestamptz is the correct instant.
    patch.transaction_datetime = entry.payment_time
      ? `${datePart}T${entry.payment_time}+05:30`
      : `${datePart}T00:00:00+05:30`;
  }
  patch.payment_mode = entry.mode || (entry.payment_id ? 'UPI' : (entry.check_id ? 'Cheque' : 'Bank Transfer'));

  if (Object.keys(patch).length > 0) {
    await db.from('fro_donor_logs').update(patch).eq('id', logId);
  }
};

export const getEntryByPaymentId = async (paymentId, status = 'unverified') => {
  let query = db
    .from('bank_audit_entries')
    .select('*, bank_audit_sources(name)')
    .eq('payment_id', paymentId);
  if (status) query = query.eq('status', status);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
};

export const ensureReceiptNumber = async (entryId) => {
  const { data: entry } = await db
    .from('bank_audit_entries')
    .select('id, receipt_id, project_id, amount, payer_name, payment_id, transaction_date, payment_time, source_id')
    .eq('id', entryId)
    .single();
  if (!entry) return;

  // The receipt's NGO decides its number sequence. Never silently force 'bsct':
  // an entry whose NGO is unknown (e.g. an Ashray donation with no assignment /
  // stale project_supported) must NOT draw a number from the Being Sevak counter.
  // Such entries are left unnumbered until their real NGO is set.
  const project = canonicalProject(entry.project_id);
  if (!project) return;

  if (entry.receipt_id) {
    const { data: receipt } = await db
      .from('receipts')
      .select('id, receipt_no, project_id')
      .eq('id', entry.receipt_id)
      .single();
    if (receipt && !receipt.receipt_no) {
      const receiptNo = await getNextReceiptNo(receipt.project_id || project);
      await db.from('receipts').update({ receipt_no: receiptNo }).eq('id', receipt.id);
      await db.from('bank_audit_entries').update({ receipt_no: receiptNo }).eq('id', entryId);
    }
  } else {
    const receiptNo = await getNextReceiptNo(project);
    const { data: newReceipt } = await db.from('receipts').insert({
      receipt_no: receiptNo,
      project_id: project,
      donor_name: entry.payer_name || 'Unknown',
      amount: entry.amount,
      receipt_date: entry.transaction_date,
      receipt_time: entry.payment_time,
      purpose: 'Bank Audit Entry',
      agent_name: 'Suspense',
    }).select().single();
    if (newReceipt) {
      await db.from('bank_audit_entries').update({ receipt_id: newReceipt.id, receipt_no: receiptNo }).eq('id', entryId);
    }
  }
};

export const verifyEntry = async (id) => {
  await ensureReceiptNumber(id);
  const { data, error } = await db
    .from('bank_audit_entries')
    .update({ status: 'verified', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const getSuspenseForNgo = async () => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .select('*, bank_audit_sources(name), donor_profiles!donor_id(name, station)')
    .eq('assigned_to_ngo_admin', true)
    .is('donor_id', null)
    .neq('status', 'verified')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getSuspenseForFro = async (froId) => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .select('*, bank_audit_sources(name), receipts!receipt_id(id, donor_id, agent_name, donor_mobile)')
    .eq('assigned_to_fro_id', froId)
    .neq('status', 'verified')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const assignSuspenseToFro = async (id, froId, notes) => {
  const { data, error } = await db
    .from('bank_audit_entries')
    .update({
      assigned_to_fro_id: froId,
      ngo_admin_notes: notes || null,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const resolveSuspense = async (id, screenshotUrl, donorDetails) => {
  await ensureReceiptNumber(id);
  const { data, error } = await db
    .from('bank_audit_entries')
    .update({
      screenshot_url: screenshotUrl || null,
      donor_details: donorDetails || null,
      status: 'verified',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const searchFroDispositions = async (froId, searchTerm) => {
  let query = db
    .from('fro_donor_logs')
    .select(`
      id, amount_collected, action, disposition_category, disposition_detail,
      accounts_status, rejection_reason, created_at,
      fro_assignments!inner(fro_worker_id, donor_profiles!inner(id, name, mobile_number, city))
    `)
    .eq('fro_assignments.fro_worker_id', froId)
    .or('accounts_status.neq.verified,and,disposition_detail.neq.lead_done')
    .order('created_at', { ascending: false })
    .limit(30);

  if (searchTerm && searchTerm.length >= 2) {
    query = query.ilike('fro_assignments.donor_profiles.name', `%${searchTerm}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id,
    amount: r.amount_collected,
    action: r.action,
    disposition_category: r.disposition_category,
    disposition_detail: r.disposition_detail,
    accounts_status: r.accounts_status,
    rejection_reason: r.rejection_reason,
    created_at: r.created_at,
    donor_id: r.fro_assignments?.donor_profiles?.id,
    donor_name: r.fro_assignments?.donor_profiles?.name || 'Unknown',
    donor_mobile: r.fro_assignments?.donor_profiles?.mobile_number || '',
    donor_city: r.fro_assignments?.donor_profiles?.city || '',
  }));
};

export const linkSuspenseToDonor = async (entryId, donorId) => {
  await ensureReceiptNumber(entryId);
  const { data, error } = await db
    .from('bank_audit_entries')
    .update({
      donor_id: donorId,
      matched_at: new Date().toISOString(),
      status: 'verified',
      assigned_to_ngo_admin: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryId)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const markSuspenseUnmatched = async (entryId, markedBy) => {
  await ensureReceiptNumber(entryId);
  const { data, error } = await db
    .from('bank_audit_entries')
    .update({
      status: 'verified',
      assigned_to_ngo_admin: false,
      no_match_by: markedBy || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', entryId)
    .select('*, bank_audit_sources(name)')
    .single();
  if (error) throw error;
  return data;
};

export const searchDonorsForSuspense = async (searchTerm, ngoIds) => {
  if (!searchTerm || searchTerm.trim().length < 2) return [];
  const term = `%${searchTerm.trim()}%`;
  const { data, error } = await db
    .from('donor_profiles')
    .select('id, name, mobile_number, city, amount, total_amount, station')
    .or(`name.ilike.${term},mobile_number.ilike.${term}`)
    .limit(20);
  if (error) throw error;
  if (!data || data.length === 0) return [];

  const donorIds = data.map(d => d.id);
  const { data: assignments } = await db
    .from('fro_assignments')
    .select('donor_id, fro_worker_id, workers!left(name, login_id)')
    .in('donor_id', donorIds)
    .not('status', 'eq', 'reassigned');

  const froMap = {};
  for (const a of assignments || []) {
    if (!froMap[a.donor_id]) froMap[a.donor_id] = { name: a.workers?.name || 'Unknown', login_id: a.workers?.login_id || '' };
  }

  return data.map(d => ({
    id: d.id,
    name: d.name,
    mobile_number: d.mobile_number,
    city: d.city,
    amount: d.amount,
    total_amount: d.total_amount,
    station: d.station || null,
    fro_name: froMap[d.id]?.name || null,
    fro_login: froMap[d.id]?.login_id || null,
  }));
};

// A field value counts as missing for the fill-if-empty rule when it is NULL,
// empty, or the 'NA'/'Suspense' marker (case-insensitive, trimmed).
const isEmptyValue = (value) => {
  if (value === null || value === undefined) return true;
  const s = String(value).trim();
  if (s === '') return true;
  const lower = s.toLowerCase();
  return lower === 'na' || lower === 'suspense';
};

// Best-effort: copy a suspense receipt's donor details (PAN, address, email,
// mobile, MOP) onto the donor profile, but only where the profile is missing
// them — so the linked lead shows the money's real data (address, PAN card)
// without ever overwriting already-known profile data. Used by the FRO claim,
// auto-match, and manual suspense-match paths.
export const enrichDonorProfileFromReceipt = async (donorId, receipt) => {
  if (!donorId || !receipt) return;
  const { data: profile, error } = await db
    .from('donor_profiles')
    .select('pan_number, address_1, address_2, email, mobile_number, mop')
    .eq('id', donorId)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return;

  const patch = {};
  if (isEmptyValue(profile.pan_number) && !isEmptyValue(receipt.pan_number)) patch.pan_number = String(receipt.pan_number).trim();
  if (isEmptyValue(profile.address_1) && !isEmptyValue(receipt.address)) patch.address_1 = String(receipt.address).trim();
  if (isEmptyValue(profile.email) && !isEmptyValue(receipt.email)) patch.email = String(receipt.email).trim();
  if (isEmptyValue(profile.mobile_number) && !isEmptyValue(receipt.donor_mobile)) patch.mobile_number = String(receipt.donor_mobile).trim();
  if (isEmptyValue(profile.mop) && !isEmptyValue(receipt.mode)) patch.mop = String(receipt.mode).trim();
  if (Object.keys(patch).length === 0) return;

  patch.updated_at = new Date().toISOString();
  const { error: updErr } = await db.from('donor_profiles').update(patch).eq('id', donorId);
  if (updErr) throw updErr;
};
