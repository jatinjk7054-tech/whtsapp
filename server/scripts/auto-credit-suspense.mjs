import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const MONTH_START = '2026-08-01';
const MONTH_END = '2026-08-31';

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SUSPENSE_VALUES = new Set(['', 'suspense', 'na', 'n/a', 'null', '-']);
const isSuspenseAgent = (a) => !a || SUSPENSE_VALUES.has(String(a).trim().toLowerCase());

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const findDonor = async (name) => {
  if (!name) return null;
  const n = norm(name);
  if (!n || n.length < 3) return null;
  if (/[*?]/.test(name)) return null;
  const exact = await client.query(
    `SELECT id, name, total_amount, donation_count, last_donation_date
     FROM donor_profiles
     WHERE lower(trim(name)) = $1
     ORDER BY id LIMIT 1`,
    [n]
  );
  if (exact.rows.length) return exact.rows[0];
  const ilike = await client.query(
    `SELECT id, name, total_amount, donation_count, last_donation_date
     FROM donor_profiles
     WHERE lower(trim(name)) ILIKE $1
     ORDER BY id LIMIT 1`,
    [n]
  );
  return ilike.rows[0] || null;
};

const findWorker = async (agentName) => {
  if (!agentName || isSuspenseAgent(agentName)) return null;
  const n = norm(agentName);
  const r = await client.query(
    `SELECT id, name FROM workers
     WHERE lower(trim(name)) = $1
     ORDER BY id LIMIT 1`,
    [n]
  );
  return r.rows[0] || null;
};

const ngoIdForProject = async (projectId) => {
  if (!projectId) return null;
  const r = await client.query(
    `SELECT id FROM ngos WHERE lower(trim(name)) = $1 ORDER BY id LIMIT 1`,
    [String(projectId).trim().toLowerCase()]
  );
  return r.rows[0]?.id || null;
};

const ensureAssignment = async (donorId, workerId, ngoId) => {
  const existing = await client.query(
    `SELECT id FROM fro_assignments
     WHERE donor_id = $1
       AND ($2::uuid IS NULL OR fro_worker_id = $2)
       AND ($3::int IS NULL OR ngo_id = $3)
     ORDER BY id LIMIT 1`,
    [donorId, workerId, ngoId]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const ins = await client.query(
    `INSERT INTO fro_assignments (donor_id, fro_worker_id, ngo_id, status, assigned_at)
     VALUES ($1, $2, $3, 'donation_collected', NOW())
     RETURNING id`,
    [donorId, workerId, ngoId]
  );
  return ins.rows[0].id;
};

const creditReceipt = async (r, donor, worker, ngoId) => {
  const assignmentId = await ensureAssignment(donor.id, worker?.id || null, ngoId);

  const ins = await client.query(
    `INSERT INTO fro_donor_logs
       (assignment_id, donor_id, fro_worker_id, action, disposition_detail,
        amount_collected, accounts_status, upi_transaction_id, payment_mode,
        payment_from, transaction_datetime, verified_at, created_at, created_by)
     VALUES ($1, $2, $3, 'disposition', 'lead_done',
        $4, 'verified', $5, $6,
        $7, $8, NOW(), NOW(), $3)
     RETURNING id`,
    [
      assignmentId,
      donor.id,
      worker?.id || null,
      r.amount,
      r.payment_id || null,
      r.mode || 'UPI',
      r.bank_payer_name || r.donor_name || null,
      r.transaction_dt || r.receipt_date || null,
    ]
  );
  const logId = ins.rows[0].id;

  if (!r.project_id) {
    // No known NGO for this receipt — never draw a number from the Being Sevak
    // counter. Leave it unnumbered so it can be attributed to the right NGO.
    const err = new Error('No project_id for receipt — cannot allocate a receipt number safely.');
    err.code = 'NO_PROJECT';
    throw err;
  }
  const no = await client.query(`SELECT next_receipt_no($1) AS n`, [r.project_id]);
  const receiptNo = String(no.rows[0].n);

  await client.query(
    `UPDATE receipts
     SET donor_id = $1, log_id = $2, receipt_no = $3,
         agent_name = COALESCE(NULLIF(trim($4), ''), agent_name),
         purpose = COALESCE(NULLIF(purpose, ''), 'Bank Audit Match'),
         updated_at = NOW()
     WHERE id = $5`,
    [donor.id, logId, receiptNo, worker?.name || null, r.id]
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
       WHERE upper(trim(coalesce(payment_id,''))) = upper($5)
          OR receipt_id = $3`,
      [donor.id, logId, r.id, receiptNo, upi]
    );
  }

  return { logId, receiptNo };
};

const run = async () => {
  await client.connect();

  const { rows } = await client.query(
    `SELECT r.id, r.receipt_no, r.donor_name, r.donor_mobile, r.amount,
            r.receipt_date, r.receipt_time, r.project_id, r.payment_id,
            r.agent_name, r.mode, r.bank_payer_name,
            r.receipt_date || ' ' || COALESCE(r.receipt_time, '00:00') AS transaction_dt,
            r.created_at
     FROM receipts r
     WHERE r.donor_id IS NULL
       AND r.log_id IS NULL
       AND r.receipt_date BETWEEN $1 AND $2
     ORDER BY r.receipt_date, r.id`,
    [MONTH_START, MONTH_END]
  );

  console.log(`Suspense receipts in ${MONTH_START}..${MONTH_END}: ${rows.length}`);
  if (!rows.length) { await client.end(); return; }

  const matched = [];
  const unmatched = [];

  for (const r of rows) {
    const donor = await findDonor(r.donor_name);
    const worker = await findWorker(r.agent_name);
    const ngoId = await ngoIdForProject(r.project_id);
    if (donor) {
      matched.push({ r, donor, worker, ngoId });
    } else {
      unmatched.push({ r, reason: donor === null ? 'no donor match' : 'masked name' });
    }
  }

  console.log(`\n=== MATCHED (${matched.length}) ===`);
  for (const m of matched) {
    console.log(
      `#${m.r.id} | ${m.r.receipt_date} | ${m.r.project_id || '-'} | "${m.r.donor_name}" -> donor#${m.donor.id} (${m.donor.name}) | agent="${m.r.agent_name || '-'}" -> worker=${m.worker?.name || 'NONE'} | amt=${m.r.amount} | upi=${m.r.payment_id || '-'}`
    );
  }

  console.log(`\n=== UNMATCHED (${unmatched.length}) — SKIPPED ===`);
  for (const u of unmatched) {
    console.log(
      `#${u.r.id} | ${u.r.receipt_date} | ${u.r.project_id || '-'} | "${u.r.donor_name}" | amt=${u.r.amount} | ${u.reason}`
    );
  }

  if (!APPLY) {
    console.log('\n[DRY RUN] No changes made. Re-run with --apply to credit the matched receipts.');
    await client.end();
    return;
  }

  console.log('\n=== APPLYING CREDITS ===');
  for (const m of matched) {
    try {
      const res = await creditReceipt(m.r, m.donor, m.worker, m.ngoId);
      console.log(`CREDITED receipt#${m.r.id} -> donor#${m.donor.id} log#${res.logId} receipt_no=${res.receiptNo}`);
    } catch (e) {
      console.error(`FAILED receipt#${m.r.id} (${m.r.donor_name}):`, e.message);
    }
  }

  await client.end();
};

run().catch((e) => { console.error(e); process.exit(1); });