-- ============================================================================
-- Repair: duplicate audit entries (email-imported bank entry + uploaded receipt
-- for the same UPI/payment reference) and the vanished verified lead.
--
-- Run on the server (psql/Supabase SQL editor) where the DB is reachable.
-- Safe to re-run (idempotent). Review the reports, then run the updates.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0) REPORTS (read-only) — run these first and check the output
-- ────────────────────────────────────────────────────────────────────────────

-- (0a) All payment_ids that exist as BOTH a bank entry AND a receipt
SELECT b.id   AS entry_id,
       b.payment_id,
       b.amount AS entry_amount,
       b.status AS entry_status,
       b.receipt_id AS entry_receipt_id,
       r.id      AS receipt_id,
       r.receipt_no,
       r.amount   AS receipt_amount,
       r.donor_id,
       r.log_id,
       r.donor_name
FROM bank_audit_entries b
JOIN receipts r
  ON upper(trim(coalesce(b.payment_id, ''))) = upper(trim(coalesce(r.payment_id, '')))
WHERE coalesce(b.payment_id, '') <> ''
ORDER BY b.payment_id, b.id;

-- (0b) The specific donor's full state (logs, receipts, entries)
SELECT fl.id AS log_id,
       fl.accounts_status,
       fl.disposition_detail,
       fl.amount_collected,
       fl.upi_transaction_id,
       fl.transaction_datetime,
       dp.id AS donor_id,
       dp.name AS donor_name,
       dp.mobile_number
FROM fro_donor_logs fl
JOIN fro_assignments fa ON fa.id = fl.assignment_id
JOIN donor_profiles dp  ON dp.id = fa.donor_id
WHERE regexp_replace(coalesce(dp.mobile_number, ''), '[^0-9]', '', 'g') LIKE '%9819155767'
ORDER BY fl.created_at DESC;

SELECT r.id, r.receipt_no, r.project_id, r.payment_id, r.amount,
       r.donor_id, r.log_id, r.agent_name
FROM receipts r
WHERE upper(trim(coalesce(r.payment_id, ''))) IN (
  SELECT upper(trim(coalesce(b.payment_id, '')))
  FROM bank_audit_entries b
  WHERE upper(trim(coalesce(b.payment_id, ''))) <> ''
);

SELECT b.id AS entry_id, b.payment_id, b.amount, b.status, b.match_status,
       b.matched_lead_log_id, b.receipt_id, b.donor_id
FROM bank_audit_entries b
WHERE b.payment_id IS NOT NULL
  AND upper(trim(b.payment_id)) IN (
    SELECT upper(trim(coalesce(r.payment_id, '')))
    FROM receipts r WHERE r.payment_id IS NOT NULL
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 1) LINK unlinked entries to their matching receipts (same payment reference)
--    so the audit shows each transaction once.
-- ────────────────────────────────────────────────────────────────────────────
BEGIN;

UPDATE bank_audit_entries b
SET receipt_id = r.id,
    updated_at = now()
FROM receipts r
WHERE b.receipt_id IS NULL
  AND b.payment_id IS NOT NULL
  AND upper(trim(b.payment_id)) = upper(trim(r.payment_id))
  AND NOT EXISTS (
    SELECT 1 FROM bank_audit_entries b2
    WHERE b2.receipt_id = r.id AND b2.id <> b.id
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2) LINK entries to already-CLAIMED pending leads (receipts.log_id set, lead
--    still pending) so the claim appears on the entry and the same money is
--    not listed twice on the audit page.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE bank_audit_entries b
SET matched_lead_log_id = r.log_id,
    match_status   = COALESCE(b.match_status, 'matched'),
    match_source   = COALESCE(b.match_source, 'repair'),
    matched_at     = COALESCE(b.matched_at, now()),
    updated_at     = now(),
    receipt_id     = r.id
FROM receipts r
JOIN fro_donor_logs fl ON fl.id = r.log_id
WHERE r.log_id IS NOT NULL
  AND fl.accounts_status = 'pending'
  AND b.payment_id IS NOT NULL
  AND upper(trim(b.payment_id)) = upper(trim(r.payment_id))
  AND (b.matched_lead_log_id IS NULL OR b.matched_lead_log_id = r.log_id);

COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) RECOVER the vanished verified lead for mobile 9819155767.
--    PREFERRED: use the Lead Verification "Undo" action in the app — it also
--    reverses any receipt / bank entry / donor-total side-effects.
--    Only if the lead is unreachable in the UI, flip it back to pending with:
-- ────────────────────────────────────────────────────────────────────────────
-- BEGIN;
-- UPDATE fro_donor_logs fl
-- SET accounts_status = 'pending', verified_at = NULL, verified_by = NULL
-- FROM fro_assignments fa
-- JOIN donor_profiles dp ON dp.id = fa.donor_id
-- WHERE fa.id = fl.assignment_id
--   AND fl.disposition_detail = 'lead_done'
--   AND fl.accounts_status = 'verified'
--   AND regexp_replace(coalesce(dp.mobile_number, ''), '[^0-9]', '', 'g') LIKE '%9819155767';
-- COMMIT;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) VERIFY — re-run report (0a); entries and receipts sharing a payment_id
--    should now each have a matching receipt_id on the entry.
-- ────────────────────────────────────────────────────────────────────────────
