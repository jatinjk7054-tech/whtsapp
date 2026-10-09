import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SUSPENSE_VALUES = new Set(['', 'suspense', 'na', 'n/a', 'null', '-']);
const isSuspenseAgent = (a) => !a || SUSPENSE_VALUES.has(String(a).trim().toLowerCase());
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isMasked = (s) => /[*?]/.test(String(s || ''));

const readTargetIds = () =>
  fs.readFileSync(path.join(__dirname, 'target_payment_ids.txt'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/)[0]);

const findDonor = async (name) => {
  if (!name || isMasked(name)) return null;
  const n = norm(name);
  if (!n || n.length < 3) return null;
  const exact = await client.query(
    `SELECT id, name, total_amount, donation_count, last_donation_date
     FROM donor_profiles WHERE lower(trim(name)) = $1 ORDER BY id LIMIT 1`, [n]
  );
  if (exact.rows.length) return exact.rows[0];
  const ilike = await client.query(
    `SELECT id, name, total_amount, donation_count, last_donation_date
     FROM donor_profiles WHERE lower(trim(name)) ILIKE $1 ORDER BY id LIMIT 1`, [n]
  );
  return ilike.rows[0] || null;
};

const findOrCreateDonor = async (receipt) => {
  const existing = await findDonor(receipt.donor_name);
  if (existing) return existing;
  const mobile = receipt.donor_mobile || `NOCELL-${Date.now()}`;
  const ins = await client.query(
    `INSERT INTO donor_profiles (name, mobile_number, project_supported, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     RETURNING id, name, total_amount, donation_count, last_donation_date`,
    [receipt.donor_name || 'Unknown Donor', mobile, receipt.project_id || 'bsct']
  );
  const d = ins.rows[0];
  d.created_new = true;
  return d;
};

const findWorkerByName = async (agentName) => {
  if (!agentName || isSuspenseAgent(agentName)) return null;
  const r = await client.query(
    `SELECT id, name FROM workers WHERE lower(trim(name)) = $1 ORDER BY id LIMIT 1`, [norm(agentName)]
  );
  return r.rows[0] || null;
};

const ngoIdForProject = async (projectId) => {
  if (!projectId) return null;
  const r = await client.query(
    `SELECT id FROM ngos WHERE lower(trim(name)) = $1 ORDER BY id LIMIT 1`, [String(projectId).trim().toLowerCase()]
  );
  return r.rows[0]?.id || null;
};

const ensureAssignment = async (donorId, workerId, ngoId) => {
  const existing = await client.query(
    `SELECT id FROM fro_assignments
     WHERE donor_id = $1 AND ($2::uuid IS NULL OR fro_worker_id = $2) AND ($3::uuid IS NULL OR ngo_id = $3)
     ORDER BY id LIMIT 1`, [donorId, workerId, ngoId]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const ins = await client.query(
    `INSERT INTO fro_assignments (donor_id, fro_worker_id, ngo_id, status, assigned_at)
     VALUES ($1, $2, $3, 'donation_collected', NOW()) RETURNING id`, [donorId, workerId, ngoId]
  );
  return ins.rows[0].id;
};

const creditUnclaimed = async (r, donor, worker, ngoId) => {
  const upi = String(r.payment_id || '').trim().toUpperCase();
  if (upi) {
    const existingLog = await client.query(
      `SELECT id FROM fro_donor_logs
       WHERE upper(trim(coalesce(upi_transaction_id,''))) = $1
       ORDER BY id LIMIT 1`, [upi]
    );
    if (existingLog.rows.length) return { logId: existingLog.rows[0].id, assignmentId: null, reused: true };
  }
  const assignmentId = await ensureAssignment(donor.id, worker?.id || null, ngoId);
  const ins = await client.query(
    `INSERT INTO fro_donor_logs
       (assignment_id, donor_id, fro_worker_id, action, disposition_detail,
        amount_collected, accounts_status, upi_transaction_id, payment_mode,
        payment_from, transaction_datetime, verified_at, created_at, created_by)
     VALUES ($1, $2, $3, 'disposition', 'lead_done',
        $4, 'verified', $5, $6, $7, $8, NOW(), NOW(), $3)
     RETURNING id`,
    [assignmentId, donor.id, worker?.id || null, r.amount, r.payment_id || null,
     r.mode || 'UPI', r.bank_payer_name || r.donor_name || null,
     r.transaction_dt || r.receipt_date || null]
  );
  return { logId: ins.rows[0].id, assignmentId };
};

const verifyClaimed = async (r, donor, log) => {
  if (log.accounts_status === 'verified') return { skipped: true };
  await client.query(
    `UPDATE fro_donor_logs SET accounts_status = 'verified', verified_at = NOW()
     WHERE id = $1`, [log.id]
  );
  await client.query(
    `UPDATE fro_assignments SET status = 'donation_collected', last_contacted_at = NOW()
     WHERE id = $1`, [log.assignment_id]
  );
  return { logId: log.id, assignmentId: log.assignment_id };
};

const linkReceiptOnly = async (r, logRow, workerName) => {
  if (!r.project_id) {
    // Never draw from the Being Sevak counter for a receipt with no known NGO.
    throw new Error('No project_id for receipt — cannot allocate a receipt number safely.');
  }
  const no = await client.query(`SELECT next_receipt_no($1) AS n`, [r.project_id]);
  const receiptNo = String(no.rows[0].n);
  const donorId = logRow.log_donor_id;
  await client.query(
    `UPDATE receipts
     SET donor_id = $1, log_id = $2, receipt_no = $3,
         agent_name = COALESCE(NULLIF(trim($4), ''), agent_name),
         purpose = COALESCE(NULLIF(purpose, ''), 'Bank Audit Match')
     WHERE id = $5`,
    [donorId, logRow.id, receiptNo, workerName, r.id]
  );
  const upi = String(r.payment_id || '').trim();
  if (upi) {
    await client.query(
      `UPDATE bank_audit_entries
       SET status = 'verified', donor_id = $1, matched_lead_log_id = $2,
           match_status = 'confirmed', receipt_id = $3, receipt_no = $4,
           matched_at = NOW(), updated_at = NOW()
       WHERE upper(trim(coalesce(payment_id,''))) = upper($5) OR receipt_id = $3`,
      [donorId, logRow.id, r.id, receiptNo, upi]
    );
  }
  return { logId: logRow.id, receiptNo };
};

const applyCredit = async (r, donor, worker, ngoId, logInfo, claimedWorkerName) => {
  const { logId, assignmentId } = logInfo;

  if (!r.project_id) {
    // Never draw from the Being Sevak counter for a receipt with no known NGO.
    throw new Error('No project_id for receipt — cannot allocate a receipt number safely.');
  }
  const no = await client.query(`SELECT next_receipt_no($1) AS n`, [r.project_id]);
  const receiptNo = String(no.rows[0].n);

  const workerName = claimedWorkerName || worker?.name || null;

  await client.query(
    `UPDATE receipts
     SET donor_id = $1, log_id = $2, receipt_no = $3,
         agent_name = COALESCE(NULLIF(trim($4), ''), agent_name),
         purpose = COALESCE(NULLIF(purpose, ''), 'Bank Audit Match')
     WHERE id = $5`,
    [donor.id, logId, receiptNo, workerName, r.id]
  );

  await client.query(
    `UPDATE donor_profiles
     SET total_amount = ROUND((COALESCE(total_amount,0) + $1)::numeric, 2),
         donation_count = COALESCE(donation_count, 0) + 1,
         last_donation_date = GREATEST(COALESCE(last_donation_date, '1000-01-01'::date), $2::date),
         updated_at = NOW()
     WHERE id = $3`,
    [r.amount, r.receipt_date || '2026-08-01', donor.id]
  );

  const upi = String(r.payment_id || '').trim();
  if (upi) {
    await client.query(
      `UPDATE bank_audit_entries
       SET status = 'verified', donor_id = $1, matched_lead_log_id = $2,
           match_status = 'confirmed', receipt_id = $3, receipt_no = $4,
           matched_at = NOW(), updated_at = NOW()
       WHERE upper(trim(coalesce(payment_id,''))) = upper($5) OR receipt_id = $3`,
      [donor.id, logId, r.id, receiptNo, upi]
    );
  }
  return { logId, receiptNo, assignmentId };
};

const run = async () => {
  await client.connect();
  const targetIds = readTargetIds();
  console.log(`Target payment IDs: ${targetIds.length}`);

  const { rows } = await client.query(
    `SELECT r.id, r.receipt_no, r.donor_name, r.donor_mobile, r.amount,
            r.receipt_date, r.receipt_time, r.project_id, r.payment_id,
            r.agent_name, r.mode, r.bank_payer_name, r.log_id,
            r.receipt_date || ' ' || COALESCE(r.receipt_time, '00:00') AS transaction_dt,
            l.accounts_status AS log_status, l.assignment_id AS log_assignment_id
     FROM receipts r
     LEFT JOIN fro_donor_logs l ON l.id = r.log_id
     WHERE upper(trim(r.payment_id)) = ANY($1::text[])`,
    [targetIds.map((x) => x.toUpperCase())]
  );
  console.log(`Receipts found: ${rows.length}\n`);

  for (const r of rows) {
    const upi = String(r.payment_id || '').trim().toUpperCase();
    const donorName = r.donor_name || 'Unknown Donor';
    const masked = isMasked(donorName);
    const claimed = r.log_id != null;
    console.log(`--- #${r.id} | ${r.receipt_date} | ${r.project_id || '-'} | "${donorName}" | ₹${r.amount} | upi=${upi} | ${claimed ? 'CLAIMED(log=' + r.log_id + ',status=' + r.log_status + ')' : 'UNCLAIMED'} | agent="${r.agent_name || '-'}"`);

    if (masked) { console.log('  SKIP: masked name.'); continue; }

    let logInfo = null;
    let claimedWorkerName = null;
    let claimedLogRow = null;

    if (claimed) {
      const check = await client.query(
        `SELECT l.id, l.accounts_status, l.assignment_id, l.donor_id AS log_donor_id, w.name AS worker_name
         FROM fro_donor_logs l
         LEFT JOIN fro_assignments a ON a.id = l.assignment_id
         LEFT JOIN workers w ON w.id = COALESCE(a.fro_worker_id, l.fro_worker_id)
         WHERE l.id = $1`, [r.log_id]
      );
      if (check.rows.length) {
        claimedLogRow = check.rows[0];
        claimedWorkerName = claimedLogRow.worker_name || null;
        logInfo = await verifyClaimed(r, null, claimedLogRow);
        if (logInfo.skipped) {
          console.log('  LEAD ALREADY VERIFIED - linking receipt only');
          if (!APPLY) continue;
          try {
            await linkReceiptOnly(r, claimedLogRow, claimedWorkerName);
            console.log(`  RECEIPT LINKED (existing verified lead)`);
          } catch (e) {
            console.error('  FAILED linking receipt:', e.message);
          }
          continue;
        }
      } else {
        console.log('  WARN: claimed log missing, treating as unclaimed');
      }
    }

    const donor = claimedLogRow?.log_donor_id
      ? await client.query(
          `SELECT id, name, total_amount, donation_count, last_donation_date
           FROM donor_profiles WHERE id = $1`, [claimedLogRow.log_donor_id]
        ).then((r2) => r2.rows[0] || null)
      : (APPLY ? await findOrCreateDonor(r) : await findDonor(r.donor_name));

    if (!donor) { console.log('  WARN: no donor resolved, skipping.'); continue; }

    const worker = await findWorkerByName(r.agent_name);
    const ngoId = await ngoIdForProject(r.project_id);
    console.log(`  donor -> #${donor.id} (${donor.name})${donor.created_new ? ' [NEW PROFILE]' : ''} | worker -> ${worker?.name || 'NONE'} | log_worker -> ${claimedWorkerName || 'NONE'}`);

    if (!APPLY) continue;

    try {
      if (!logInfo) {
        logInfo = await creditUnclaimed(r, donor, worker, ngoId);
      }
      const res = await applyCredit(r, donor, worker, ngoId, logInfo, claimedWorkerName);
      console.log(`  CREDITED log#${res.logId} receipt_no=${res.receiptNo}${claimed ? ' (verified existing lead)' : ' (new lead)'}`);
    } catch (e) {
      console.error(`  FAILED:`, e.message);
    }
  }

  console.log(APPLY ? '\n[DONE] Apply complete.' : '\n[DRY RUN] No changes made. Re-run with --apply.');
  await client.end();
};

run().catch((e) => { console.error(e); process.exit(1); });