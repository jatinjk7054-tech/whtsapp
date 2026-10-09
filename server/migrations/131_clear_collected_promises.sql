-- 131: Clear promise-to-pay assignments whose donor already collected in the
-- current donation period.
--
-- Business rule: a donor tagged with a payment promise (promise_to_pay,
-- payment_pending, will_donate_online, visit_donate, whatsapp_sent) should leave
-- the FRO's promise list once money is actually confirmed for that same NGO.
--
-- Most flows (receipt claim, direct FRO donation, accounts verify) did NOT flip
-- the assignment status, so donors with an existing receipt stayed in the
-- Promise-to-Pay list. The app now filters those at read time (getFroPromises)
-- and flips them at claim time (claimSuspenseReceipt); this migration performs
-- the one-time database cleanup for rows created OLDER than the app fix.
--
-- Rule mirrors periodStartForType() (backend/src/controllers/froController.js):
-- a receipt clears a promise only if it belongs to the donor's CURRENT donation
-- window (monthly/quarterly/half_yearly/yearly/one_time). Cross-NGO receipts
-- never clear a promise for a different NGO (project_id = ngo name lowercased).
--
-- Applied by the user via Query Runner (DB is not reachable from the app host).
-- Idempotent: after the first successful run there are no matching rows left.

BEGIN;

CREATE TEMP TABLE tmp_clear_promises ON COMMIT DROP AS
  SELECT a.id
    FROM fro_assignments a
    JOIN ngos n ON n.id = a.ngo_id
    JOIN donor_profiles d ON d.id = a.donor_id
   WHERE a.status IN (
         'promise_to_pay',
         'payment_pending',
         'will_donate_online',
         'visit_donate',
         'whatsapp_sent'
       )
     AND EXISTS (
           SELECT 1
             FROM receipts r
            WHERE r.donor_id = a.donor_id
              AND lower(r.project_id) = lower(n.name)
              AND r.receipt_date >= CASE
                    WHEN lower(COALESCE(NULLIF(d.donor_type, ''), d.donation_frequency, '')) = 'quarterly'
                      THEN date_trunc('quarter', current_date)
                    WHEN lower(COALESCE(NULLIF(d.donor_type, ''), d.donation_frequency, '')) = 'half_yearly'
                      AND extract(month from current_date) < 7
                      THEN date_trunc('year', current_date)
                    WHEN lower(COALESCE(NULLIF(d.donor_type, ''), d.donation_frequency, '')) = 'half_yearly'
                      THEN date_trunc('year', current_date) + interval '6 months'
                    WHEN lower(COALESCE(NULLIF(d.donor_type, ''), d.donation_frequency, '')) = 'yearly'
                      THEN date_trunc('year', current_date)
                    WHEN lower(COALESCE(NULLIF(d.donor_type, ''), d.donation_frequency, '')) = 'one_time'
                      THEN '2000-01-01'::date
                    ELSE date_trunc('month', current_date)
                  END
         );

UPDATE fro_assignments a
   SET status            = 'donation_collected',
       last_contacted_at = now(),
       hidden_until      = (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 month')
                           AT TIME ZONE 'Asia/Kolkata'
  FROM tmp_clear_promises t
 WHERE a.id = t.id;

-- Report how many stale promises were cleared.
SELECT count(*) AS cleared_promises FROM tmp_clear_promises;

COMMIT;