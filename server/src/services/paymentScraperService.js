import db from '../config/db.js';
import { canonicalProject, getSources, projectCodeFromNgoId } from '../models/bankAuditModel.js';
import { findAutoMatches } from './autoMatchService.js';
import { formatModeLabel } from './modeLabels.js';

// ---------------------------------------------------------------------------
// AI Payment Scraper service (scrapper/ device app ingest)
//
// Receives parsed GPay transactions from the on-device accessibility app,
// normalizes them into bank_audit_entries rows, and GUARANTEES no duplicates:
//   1. Idempotent runs — a finished run_id is never re-imported.
//   2. Server ref check — an existing bank_audit_entries row with the same
//      payment_id (UPI ref) blocks re-creation REGARDLESS of its status
//      (unverified, verified, matched, cleared — the row is the history).
//   3. Fingerprint fallback — when no ref is visible, amount + transaction_date
//      + normalized payer name + project id must be present to import.
//   4. In-batch dedup — identical rows within one upload collapse to one.
// ---------------------------------------------------------------------------

const KNOWN_PROJECTS = new Set(['bsct', 'mann', 'aflf', 'library', 'pg']);

const GOOGLE_PAY = 'Google Pay';

// --- small normalization helpers -------------------------------------------

const cleanAmount = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number.parseFloat(String(value).replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
};

// Accepts ISO (2026-08-29), and Indian DD-MM-YYYY / DD-MM-YY spellings.
const parseDate = (value) => {
  if (!value) return null;
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${month}-${day}`;
  }
  return null;
};

// Accepts HH:MM, HH:MM:SS and "7:32 pm" style GPay times → HH:MM:SS (24h).
const parseTime = (value) => {
  if (!value) return null;
  const s = String(value).trim();
  const m = /^(\d{1,2}):(\d{2})(?::?(\d{2}))?\s*([ap]m)?$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  const sec = m[3] || '00';
  const meridiem = (m[4] || '').toLowerCase();
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (h > 23 || Number(min) > 59 || Number(sec) > 59) return null;
  return `${String(h).padStart(2, '0')}:${min}:${sec}`;
};

const cleanName = (value) => {
  if (!value) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length ? s.slice(0, 200) : null;
};

const cleanMode = (value) => {
  const s = formatModeLabel(value);
  return s ? s.slice(0, 20) : null;
};

const fingerprintKey = (txn, projectId) => {
  const payer = String(txn.payerName || txn.payer_name || '').trim().toLowerCase();
  return `${projectId}|${txn.amount}|${txn.transactionDate}|${payer}`;
};

// --- Google Pay source resolution ------------------------------------------

let googlePaySourceId = null;
async function resolveGooglePaySource() {
  if (googlePaySourceId) return googlePaySourceId;
  const sources = await getSources();
  const existing = sources.find((s) => s.name === GOOGLE_PAY && s.kind === 'bank');
  if (existing) {
    googlePaySourceId = existing.id;
    return existing.id;
  }
  const { data: created, error } = await db
    .from('bank_audit_sources')
    .insert({ name: GOOGLE_PAY, kind: 'bank', sort_order: 99 })
    .select()
    .single();
  if (error) throw error;
  googlePaySourceId = created.id;
  return created.id;
}

let bankSourceCache = new Map();
async function resolveBankSource(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  if (bankSourceCache.has(key)) return bankSourceCache.get(key);
  const { data: sources, error } = await db
    .from('bank_audit_sources')
    .select('id, name, kind, is_active, sort_order')
    .eq('kind', 'bank');
  if (error) throw error;
  const existing = (sources || []).find((s) => s.name.toLowerCase() === key);
  if (existing) {
    bankSourceCache.set(key, existing.id);
    return existing.id;
  }
  const { data: created, error: insErr } = await db
    .from('bank_audit_sources')
    .insert({ name: name.trim(), kind: 'bank', sort_order: 99 })
    .select()
    .single();
  if (insErr) throw insErr;
  bankSourceCache.set(key, created.id);
  return created.id;
}

// --- run + assistant models -------------------------------------------------

export async function resolveProjectCode(rawProjectId) {
  if (!rawProjectId) return null;
  const canonical = canonicalProject(rawProjectId);
  if (KNOWN_PROJECTS.has(canonical)) return canonical;
  try {
    const { data: ngos } = await db.from('ngos').select('id, name');
    const needle = String(rawProjectId).trim().toLowerCase();
    const hit = (ngos || []).find((n) => String(n.id).trim().toLowerCase() === needle);
    if (hit) {
      const code = await projectCodeFromNgoId(hit.id);
      if (code && KNOWN_PROJECTS.has(code)) return code;
    }
  } catch (err) {
    console.error('Failed to resolve NGO project code:', err.message);
  }
  return canonical;
}

export async function listNgoProjectCodes() {
  const { data: ngos, error } = await db.from('ngos').select('id, name');
  if (error) throw error;
  const out = [];
  for (const ngo of ngos || []) {
    try {
      const code = await projectCodeFromNgoId(ngo.id);
      if (code && KNOWN_PROJECTS.has(code)) out.push({ id: ngo.id, name: ngo.name, project_code: code });
    } catch (err) {
      console.error('Failed computing project code for NGO:', ngo.id, err.message);
    }
  }
  if (out.length === 0) {
    // Fall back to the canonical set when the ngos table has no matching rows.
    for (const code of ['bsct', 'mann', 'aflf', 'library', 'pg']) {
      out.push({ id: code, name: code.toUpperCase(), project_code: code });
    }
  }
  return out;
}

async function touchRunStart(runId, deviceLabel, projectId, transactionsSeen) {
  const { data: run, error } = await db
    .from('scraper_runs')
    .insert({
      run_id: runId,
      device_label: deviceLabel,
      project_id: projectId,
      status: 'running',
      transactions_seen: transactionsSeen,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return run;
}

async function findFinishedRun(runId) {
  const { data, error } = await db
    .from('scraper_runs')
    .select('*')
    .eq('run_id', runId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.status === 'complete' || data.status === 'error') return data;
  return null;
}

async function touchRunEnd(runId, { status, imported, skipped, errored, errorMessage }) {
  const { error } = await db
    .from('scraper_runs')
    .update({
      status,
      imported,
      skipped,
      errored,
      error_message: errorMessage || null,
      finished_at: new Date().toISOString(),
    })
    .eq('run_id', runId);
  if (error) throw error;
}

async function logRunEntry(runId, entry) {
  const { error } = await db
    .from('scraper_run_entries')
    .insert({
      run_id: runId,
      entry_id: entry.entry_id || null,
      payment_id: entry.payment_id || null,
      amount: entry.amount || null,
      payer_name: entry.payer_name || null,
      transaction_date: entry.transaction_date || null,
      status: entry.status,
      reason: entry.reason || null,
    })
    .select('id');
  if (error) console.error('Failed logging scraper run entry:', error.message);
}

// --- existence checks --------------------------------------------------------

async function entryExistsByPaymentId(paymentId) {
  if (!paymentId) return false;
  // Note: deliberately NO status filter — verified/cleared rows still block
  // re-creation. The row is the duplicate history.
  const { data } = await db
    .from('bank_audit_entries')
    .select('id')
    .eq('payment_id', paymentId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function entryExistsByFingerprint(projectId, amount, transactionDate, payerName) {
  const { data } = await db
    .from('bank_audit_entries')
    .select('id')
    .is('payment_id', null)
    .eq('transaction_date', transactionDate)
    .eq('amount', amount)
    .eq('payer_name', payerName)
    .eq('project_id', projectId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// --- normalization of one incoming transaction ------------------------------

export function normalizeScrapedTransaction(raw) {
  const amount = cleanAmount(raw?.amount ?? raw?.mopAmount);
  const transactionDate = parseDate(raw?.transaction_date ?? raw?.date);
  const paymentTime = parseTime(raw?.payment_time ?? raw?.time);
  const paymentId = raw?.payment_id ? String(raw.payment_id).trim().slice(0, 100) : null;
  const payerName = cleanName(raw?.payer_name ?? raw?.name ?? raw?.sender);
  const mode = cleanMode(raw?.mop ?? raw?.mode);
  const bankName = raw?.bank_name ? cleanName(raw.bank_name) : (raw?.received_bank ? cleanName(raw.received_bank) : null);
  const remarks = raw?.remarks ? String(raw.remarks).slice(0, 500) : null;

  if (!amount) return { error: 'Missing or invalid amount' };
  if (!transactionDate) return { error: 'Missing or invalid transaction_date' };
  if (!payerName) return { error: 'Missing payer_name (sender)' };

  return { amount, transactionDate, paymentTime, paymentId, payerName, mode, bankName, remarks };
}

// --- main entry: ingest a full device batch ----------------------------------

export const importScrapedBatch = async ({
  projectId,
  runId,
  deviceLabel = 'Unknown device',
  transactions = [],
  autoMatch = true,
}) => {
  if (!runId) throw new Error('runId is required');
  if (transactions.length > 1000) throw new Error('Batch too large (max 1000 transactions)');

  const done = await findFinishedRun(runId);
  if (done) {
    return {
      idempotent: true,
      run_id: runId,
      ...done,
      summary: {
        transactions_seen: done.transactions_seen,
        imported: done.imported,
        skipped: done.skipped,
        errored: done.errored,
      },
    };
  }

  const resolvedProject = (await resolveProjectCode(projectId)) || projectId;

  const batch = transactions.map((raw) => normalizeScrapedTransaction(raw));
  const seenRefs = new Set();
  const seenFingerprints = new Set();
  const importedList = [];
  let skipped = 0;
  let errored = 0;
  const errorMessages = [];

  await touchRunStart(runId, deviceLabel, resolvedProject, transactions.length);

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];

    if (item.error) {
      errored++;
      errorMessages.push(item.error);
      await logRunEntry(runId, {
        amount: null, status: 'error',
        reason: item.error,
        payment_id: transactions[i]?.payment_id ? String(transactions[i].payment_id).slice(0, 100) : null,
      });
      continue;
    }

    const { amount, transactionDate, paymentTime, paymentId, payerName, mode, bankName, remarks } = item;

    // Reuse an existing source_id matching the received-bank name, else fall
    // back to Google Pay for rows without a bank selection.
    const sourceId = bankName ? (await resolveBankSource(bankName)) : (await resolveGooglePaySource());

    // In-batch dedup by ref first, then fingerprint.
    if (paymentId) {
      if (seenRefs.has(paymentId)) {
        skipped++;
        await logRunEntry(runId, { payment_id: paymentId, amount, payer_name: payerName, transaction_date: transactionDate, status: 'skipped', reason: 'Duplicate within batch (same UPI reference)' });
        continue;
      }
      seenRefs.add(paymentId);
    } else {
      const fp = fingerprintKey(item, resolvedProject);
      if (seenFingerprints.has(fp)) {
        skipped++;
        await logRunEntry(runId, { payment_id: null, amount, payer_name: payerName, transaction_date: transactionDate, status: 'skipped', reason: 'Duplicate within batch (same amount/date/payer)' });
        continue;
      }
      seenFingerprints.add(fp);
    }

    // Server-side hard checks across ALL statuses.
    if (paymentId && (await entryExistsByPaymentId(paymentId))) {
      skipped++;
      await logRunEntry(runId, { payment_id: paymentId, amount, payer_name: payerName, transaction_date: transactionDate, status: 'skipped', reason: 'Audit entry already exists for this UPI reference' });
      continue;
    }
    if (!paymentId && (await entryExistsByFingerprint(resolvedProject, amount, transactionDate, payerName))) {
      skipped++;
      await logRunEntry(runId, { payment_id: null, amount, payer_name: payerName, transaction_date: transactionDate, status: 'skipped', reason: 'Audit entry already exists (same amount/date/payer/project)' });
      continue;
    }

    const { data: entry, error: insErr } = await db
      .from('bank_audit_entries')
      .insert({
        source_id: sourceId,
        amount,
        payment_id: paymentId,
        transaction_date: transactionDate,
        payment_time: paymentTime,
        payer_name: payerName,
        mode,
        project_id: resolvedProject,
        status: 'unverified',
        remarks: remarks || `Scraped from Google Pay (${deviceLabel})`,
        created_by: null,
      })
      .select('id, payment_id')
      .single();

    if (insErr) {
      errored++;
      errorMessages.push(insErr.message);
      await logRunEntry(runId, { payment_id: paymentId, amount, payer_name: payerName, transaction_date: transactionDate, status: 'error', reason: insErr.message });
      continue;
    }

    importedList.push(entry);
    await logRunEntry(runId, { entry_id: entry.id, payment_id: entry.payment_id || paymentId, amount, payer_name: payerName, transaction_date: transactionDate, status: 'imported', reason: null });
  }

  const result = {
    idempotent: false,
    run_id: runId,
    project_id: resolvedProject,
    device_label: deviceLabel,
    source: GOOGLE_PAY,
    summary: {
      transactions_seen: transactions.length,
      imported: importedList.length,
      skipped,
      errored,
    },
    imported_ids: importedList.map((e) => e.id),
    error_messages: [...new Set(errorMessages)].slice(0, 5),
  };

  try {
    await touchRunEnd(runId, {
      status: errored > 0 && importedList.length === 0 ? 'error' : 'complete',
      imported: importedList.length,
      skipped,
      errored,
      errorMessage: null,
    });
  } catch (err) {
    console.error('Failed finalizing scraper run:', err.message);
  }

  if (autoMatch && importedList.length > 0) {
    try {
      await findAutoMatches();
    } catch (err) {
      console.error('Auto-match after scraper import failed:', err.message);
    }
  }

  return result;
};

// --- panel-facing status -----------------------------------------------------

export const getScraperStatus = async () => {
  const { data: latest, error } = await db
    .from('scraper_runs')
    .select('*')
    .limit(8)
    .order('started_at', { ascending: false });
  if (error) throw error;
  return { runs: latest || [] };
};