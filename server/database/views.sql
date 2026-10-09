-- Database Views for NGO Admin Dashboard
-- Run these in Supabase SQL Editor

-- 1. Hourly Donation Performance (verified only)
CREATE OR REPLACE VIEW hourly_donation_performance AS
SELECT 
  date_trunc('hour', l.created_at) as hour_bucket,
  COUNT(*) as total_calls,
  COUNT(*) FILTER (WHERE l.disposition_detail IN (
    'contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 
    'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 
    'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 
    'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 
    'language_barrier', 'transferred_senior', 'query_complaint', 
    'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 
    'wrong_person', 'call_disconnected', 'callback'
  )) as connected,
  COUNT(*) FILTER (WHERE l.disposition_detail IN (
    'lead_done', 'donation_collected', 'visit_donate', 'will_donate_online',
    'promise_to_pay', 'payment_pending'
  )) as interested,
  COUNT(*) FILTER (WHERE l.accounts_status = 'verified') as donations,
  COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified'), 0) as amount
FROM fro_donor_logs l
JOIN fro_assignments a ON l.assignment_id = a.id
WHERE l.created_at >= CURRENT_DATE
GROUP BY 1
ORDER BY 1;

-- 2. Follow-up Buckets
CREATE OR REPLACE VIEW followup_buckets AS
SELECT 
  fa.id as assignment_id,
  fa.fro_worker_id,
  w.name as telecaller_name,
  dp.id as donor_id,
  dp.name as donor_name,
  dp.mobile_number,
  fa.next_follow_up,
  CASE 
    WHEN fa.next_follow_up < CURRENT_DATE THEN 'overdue'
    WHEN fa.next_follow_up = CURRENT_DATE THEN 'today'
    WHEN fa.next_follow_up = CURRENT_DATE + 1 THEN 'tomorrow'
    ELSE 'future'
  END as bucket,
  COALESCE((
    SELECT SUM(amount_collected) FROM fro_donor_logs 
    WHERE assignment_id = fa.id AND accounts_status = 'verified'
  ), 0) as amount_received,
  a.ngo_id
FROM fro_assignments fa
JOIN workers w ON fa.fro_worker_id = w.id
JOIN donor_profiles dp ON fa.donor_id = dp.id
WHERE fa.status NOT IN ('reassigned', 'donation_collected')
  AND fa.next_follow_up IS NOT NULL;

-- 3. FRO Claim Status Aggregation (for Telecaller Table)
CREATE OR REPLACE VIEW fro_claim_status AS
SELECT 
  l.fro_worker_id,
  a.ngo_id,
  COUNT(*) FILTER (WHERE l.accounts_status = 'pending') as claims_pending,
  COUNT(*) FILTER (WHERE l.accounts_status = 'verified') as claims_verified,
  COUNT(*) FILTER (WHERE l.accounts_status = 'rejected') as claims_rejected
FROM fro_donor_logs l
JOIN fro_assignments a ON l.assignment_id = a.id
GROUP BY l.fro_worker_id, a.ngo_id;

-- 4. Donation Funnel Aggregation
CREATE OR REPLACE VIEW donation_funnel AS
WITH assigned AS (
  SELECT COUNT(DISTINCT donor_id) as count FROM fro_assignments 
  WHERE status != 'reassigned' AND ngo_id = $1
),
called AS (
  SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
  JOIN fro_assignments a ON l.assignment_id = a.id
  WHERE a.ngo_id = $1 AND a.status != 'reassigned'
),
connected AS (
  SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
  JOIN fro_assignments a ON l.assignment_id = a.id
  WHERE a.ngo_id = $1 AND a.status != 'reassigned'
    AND l.disposition_detail IN ('contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback')
),
interested AS (
  SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
  JOIN fro_assignments a ON l.assignment_id = a.id
  WHERE a.ngo_id = $1 AND a.status != 'reassigned'
    AND l.disposition_detail IN ('lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending')
),
received AS (
  SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
  JOIN fro_assignments a ON l.assignment_id = a.id
  WHERE a.ngo_id = $1 AND a.status != 'reassigned'
    AND l.accounts_status = 'verified'
)
SELECT 
  (SELECT count FROM assigned) as assigned,
  (SELECT count FROM called) as called,
  (SELECT count FROM connected) as connected,
  (SELECT count FROM interested) as interested,
  (SELECT count FROM received) as received;

-- 5. Top/Bottom Performers
CREATE OR REPLACE VIEW fro_performance_ranked AS
WITH perf AS (
  SELECT 
    w.id as fro_id,
    w.name as fro_name,
    COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified'), 0) as total_received,
    COUNT(DISTINCT l.donor_id) FILTER (WHERE l.accounts_status = 'verified') as donor_count,
    COUNT(DISTINCT l.donor_id) FILTER (WHERE l.disposition_detail IN ('lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending')) as interested_count,
    COUNT(DISTINCT l.donor_id) FILTER (WHERE l.disposition_detail IN ('contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback')) as connected_count,
    t.target_amount,
    t.achieved_target
  FROM workers w
  LEFT JOIN fro_donor_logs l ON w.id = l.fro_worker_id
  LEFT JOIN fro_assignments a ON l.assignment_id = a.id
  LEFT JOIN fro_targets t ON w.id = t.worker_id AND t.month = date_trunc('month', CURRENT_DATE)::date
  WHERE w.department = 'FRO' AND w.is_active = true
    AND (a.ngo_id = $1 OR $1 IS NULL)
  GROUP BY w.id, w.name, t.target_amount, t.achieved_target
)
SELECT 
  fro_id,
  fro_name,
  total_received,
  donor_count,
  CASE WHEN connected_count > 0 THEN ROUND((interested_count::numeric / connected_count) * 100, 1) ELSE 0 END as conversion_pct,
  CASE WHEN target_amount > 0 THEN ROUND((COALESCE(achieved_target, total_received) / target_amount) * 100, 1) ELSE 0 END as target_pct
FROM perf
WHERE total_received > 0 OR donor_count > 0 OR connected_count > 0
ORDER BY total_received DESC;