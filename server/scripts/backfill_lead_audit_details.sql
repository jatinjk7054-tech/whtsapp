-- Backfill bank-audit payment details onto ALREADY-EXISTING pending leads
-- (suspense claims / leads created before the audit-override-at-claim fix).
-- The bank audit entry is the source of truth: payment id, txn date+time,
-- payer, and mode win over whatever was stored at claim time.
-- Safe to run more than once. Only touches pending lead_done leads.

BEGIN;

UPDATE fro_donor_logs l
SET upi_transaction_id = COALESCE(NULLIF(btrim(e.payment_id::text), ''), l.upi_transaction_id),
    transaction_datetime = COALESCE(
        CASE
          WHEN e.transaction_date IS NOT NULL AND e.payment_time IS NOT NULL
            THEN (CASE WHEN e.transaction_date::text LIKE '%T%' THEN left(e.transaction_date::text, 10) ELSE e.transaction_date::text END || 'T' || e.payment_time::text || '+05:30')::timestamptz
          WHEN e.transaction_date IS NOT NULL
            THEN (CASE WHEN e.transaction_date::text LIKE '%T%' THEN left(e.transaction_date::text, 10) ELSE e.transaction_date::text END || 'T00:00:00+05:30')::timestamptz
          ELSE NULL
        END,
        l.transaction_datetime),
    payment_mode = COALESCE(
        CASE WHEN btrim(COALESCE(e.payment_id::text, '')) <> '' THEN 'UPI'
             WHEN btrim(COALESCE(e.check_id::text, '')) <> '' THEN 'Cheque'
             ELSE NULL END,
        l.payment_mode),
    payment_from = COALESCE(NULLIF(btrim(e.payer_name::text), ''), l.payment_from)
FROM bank_audit_entries e
WHERE l.accounts_status = 'pending'
  AND l.action = 'disposition'
  AND l.disposition_detail = 'lead_done'
  AND e.matched_lead_log_id = l.id
  AND e.status <> 'verified';

-- Also point each claimed receipt at the audit entry's payment id so the
-- receipt <-> entry link is durable.
UPDATE receipts r
SET payment_id = e.payment_id
FROM bank_audit_entries e
WHERE r.id = e.receipt_id
  AND r.payment_id IS NULL
  AND e.payment_id IS NOT NULL;

COMMIT;
