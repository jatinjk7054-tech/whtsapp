-- =====================================================================
-- Rename old single dispositions to new combined disposition ids
-- Run in Supabase SQL Editor (Production) — NOT the local dev DB.
--
-- IMPORTANT: Patch the backend FIRST so it handles the combined ids
-- (froController scheduling/queue/follow-up logic, ngoAdminController
-- classification sets). Otherwise features that look for the old single
-- values (promise_to_pay, office_visit_scheduled, whatsapp_sent, etc.)
-- will silently stop working after this migration runs.
--
-- Only fro_donor_logs.disposition_detail is changed. fro_assignments.status
-- (canonical) and fro_scheduled_contacts are NOT touched.
-- =====================================================================

-- 0) DISCOVERY — any disposition_detail not in our known map shows up here.
--    If this returns rows, extend the lists below (and the backend sets)
--    BEFORE renaming. Expected extras: 'lead_done','done','donation_collected',
--    'contacted','follow_up','resolved_suspense' are intentional and OK.
SELECT disposition_detail, action, COUNT(*) AS rows
FROM fro_donor_logs
WHERE disposition_detail IS NOT NULL
  AND disposition_detail NOT IN (
    'busy','ringing','call_waiting','switched_off','out_of_coverage','unreachable',
    'wrong_number','invalid','invalid_number','rejected','temporary_network_issue',
    'voicemail','incoming_out','busy_call_waiting','ooc_unreachable_network','ringing_voicemail',
    'scheduled','callback','office_visit_scheduled','program_visit_scheduled','visit_donate',
    'will_donate_online','promise_to_pay','payment_pending','already_donated','email_sent',
    'whatsapp_sent','csr_inquiry','wants_80g_details','wants_trust_documents',
    'not_interested_now','not_interested','language_barrier','transferred_senior',
    'query_complaint','receipt_request','dnd','wrong_person','call_disconnected',
    'not_possible','office_program_visit','promise_pay_wa_email','not_interested_np','others',
    'lead_done','done','donation_collected','contacted','follow_up','resolved_suspense'
  )
GROUP BY disposition_detail, action
ORDER BY rows DESC;

-- 1) DRY RUN — see how many rows each old status has before touching anything
SELECT disposition_detail, COUNT(*) AS rows
FROM fro_donor_logs
WHERE disposition_detail IN (
  'busy','call_waiting','out_of_coverage','unreachable','temporary_network_issue',
  'ringing','voicemail','office_visit_scheduled','program_visit_scheduled',
  'promise_to_pay','whatsapp_sent','email_sent','not_interested','call_disconnected','not_possible'
)
GROUP BY disposition_detail
ORDER BY rows DESC;

-- 2) RENAME old single dispositions to the new combined ones
BEGIN;

UPDATE fro_donor_logs
SET disposition_detail = CASE disposition_detail
  WHEN 'busy'                    THEN 'busy_call_waiting'
  WHEN 'call_waiting'            THEN 'busy_call_waiting'
  WHEN 'out_of_coverage'         THEN 'ooc_unreachable_network'
  WHEN 'unreachable'             THEN 'ooc_unreachable_network'
  WHEN 'temporary_network_issue' THEN 'ooc_unreachable_network'
  WHEN 'ringing'                 THEN 'ringing_voicemail'
  WHEN 'voicemail'               THEN 'ringing_voicemail'
  WHEN 'office_visit_scheduled'  THEN 'office_program_visit'
  WHEN 'program_visit_scheduled' THEN 'office_program_visit'
  WHEN 'promise_to_pay'          THEN 'promise_pay_wa_email'
  WHEN 'whatsapp_sent'           THEN 'promise_pay_wa_email'
  WHEN 'email_sent'              THEN 'promise_pay_wa_email'
  WHEN 'not_interested'          THEN 'not_interested_np'
  WHEN 'call_disconnected'       THEN 'not_interested_np'
  WHEN 'not_possible'            THEN 'not_interested_np'
  ELSE disposition_detail
END
WHERE disposition_detail IN (
  'busy','call_waiting','out_of_coverage','unreachable','temporary_network_issue',
  'ringing','voicemail','office_visit_scheduled','program_visit_scheduled',
  'promise_to_pay','whatsapp_sent','email_sent','not_interested','call_disconnected','not_possible'
);

-- 3) VERIFY — should list only the 6 combined values (plus untouched ones)
SELECT disposition_detail, COUNT(*) AS rows
FROM fro_donor_logs
GROUP BY disposition_detail
ORDER BY rows DESC;

-- COMMIT;   -- run this once the verify output looks correct
-- ROLLBACK; -- instead of COMMIT if anything looks wrong