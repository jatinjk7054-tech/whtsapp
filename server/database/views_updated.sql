-- Database Views for NGO Admin Dashboard
-- Run these in Supabase SQL Editor

-- 1. Hourly Donation Performance (verified only) - scoped by NGO via WHERE clause
CREATE OR REPLACE VIEW hourly_donation_performance AS
SELECT 
  date_trunc('hour', l.created_at) as hour_bucket,
  a.ngo_id,
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
GROUP BY 1, 2
ORDER BY 1, 2;

-- 2. Follow-up Buckets - scoped by NGO via WHERE clause
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

-- 4. Station Performance - scoped by NGO via WHERE clause
CREATE OR REPLACE VIEW station_performance AS
SELECT 
  fa.station,
  a.ngo_id,
  COUNT(DISTINCT fa.donor_id) as total_donors,
  COUNT(DISTINCT fa.donor_id) FILTER (WHERE fa.status IN (
    'contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 
    'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 
    'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 
    'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 
    'language_barrier', 'transferred_senior', 'query_complaint', 
    'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 
    'wrong_person', 'call_disconnected', 'callback'
  )) as connected_donors,
  COUNT(DISTINCT fa.donor_id) FILTER (WHERE fa.status IN (
    'busy', 'ringing', 'call_waiting', 'unreachable', 'switched_off', 
    'out_of_coverage', 'wrong_number', 'invalid', 'invalid_number', 
    'rejected', 'temporary_network_issue', 'voicemail'
  )) as non_connected_donors,
  COUNT(DISTINCT fa.donor_id) FILTER (WHERE fa.status IN (
    'donation_collected', 'lead_done', 'done'
  )) as lead_done_donors
FROM fro_assignments fa
WHERE fa.station IS NOT NULL
  AND fa.status != 'reassigned'
GROUP BY 1, 2;

-- 5. FRO Performance Ranked - scoped by NGO via WHERE clause
CREATE OR REPLACE VIEW fro_performance_ranked AS
WITH perf AS (
  SELECT 
    w.id as fro_id,
    w.name as fro_name,
    COALESCE(SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified'), 0) as total_received,
    COUNT(DISTINCT l.donor_id) FILTER (WHERE l.accounts_status = 'verified') as donor_count,
    COUNT(DISTINCT l.donor_id) FILTER (WHERE l.disposition_detail IN (
      'lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 
      'promise_to_pay', 'payment_pending'
    )) as interested_count,
    COUNT(DISTINCT l.donor_id) FILTER (WHERE l.disposition_detail IN (
      'contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 
      'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 
      'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 
      'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 
      'language_barrier', 'transferred_senior', 'query_complaint', 
      'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 
      'wrong_person', 'call_disconnected', 'callback'
    )) as connected_count,
    t.target_amount,
    t.achieved_target
  FROM workers w
  LEFT JOIN fro_donor_logs l ON w.id = l.fro_worker_id
  LEFT JOIN fro_assignments a ON l.assignment_id = a.id
  LEFT JOIN fro_targets t ON w.id = t.worker_id AND t.month = date_trunc('month', CURRENT_DATE)::date
  WHERE w.department = 'FRO' AND w.is_active = true
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

-- 6. Donation Funnel - NGO-scoped via function
CREATE OR REPLACE FUNCTION get_donation_funnel(p_ngo_id INT)
RETURNS TABLE(stage TEXT, count BIGINT, pct NUMERIC) AS $$
BEGIN
  RETURN QUERY
  WITH assigned AS (
    SELECT COUNT(DISTINCT donor_id) as count FROM fro_assignments 
    WHERE status != 'reassigned' AND ngo_id = p_ngo_id
  ),
  called AS (
    SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
    JOIN fro_assignments a ON l.assignment_id = a.id
    WHERE a.ngo_id = p_ngo_id AND a.status != 'reassigned'
  ),
  connected AS (
    SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
    JOIN fro_assignments a ON l.assignment_id = a.id
    WHERE a.ngo_id = p_ngo_id AND a.status != 'reassigned'
      AND l.disposition_detail IN (
        'contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 
        'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 
        'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 
        'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 
        'language_barrier', 'transferred_senior', 'query_complaint', 
        'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 
        'wrong_person', 'call_disconnected', 'callback'
      )
  ),
  interested AS (
    SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
    JOIN fro_assignments a ON l.assignment_id = a.id
    WHERE a.ngo_id = p_ngo_id AND a.status != 'reassigned'
      AND l.disposition_detail IN (
        'lead_done', 'donation_collected', 'visit_donate', 'will_donate_online', 
        'promise_to_pay', 'payment_pending'
      )
  ),
  received AS (
    SELECT COUNT(DISTINCT l.donor_id) as count FROM fro_donor_logs l
    JOIN fro_assignments a ON l.assignment_id = a.id
    WHERE a.ngo_id = p_ngo_id AND a.status != 'reassigned'
      AND l.accounts_status = 'verified'
  )
  SELECT 
    'Assigned' as stage, (SELECT count FROM assigned) as count, 100 as pct
  UNION ALL
  SELECT 'Called', (SELECT count FROM called), 
    CASE WHEN (SELECT count FROM assigned) > 0 THEN ROUND((SELECT count FROM called)::numeric / (SELECT count FROM assigned) * 100, 1) ELSE 0 END
  UNION ALL
  SELECT 'Connected', (SELECT count FROM connected), 
    CASE WHEN (SELECT count FROM assigned) > 0 THEN ROUND((SELECT count FROM connected)::numeric / (SELECT count FROM assigned) * 100, 1) ELSE 0 END
  UNION ALL
  SELECT 'Interested', (SELECT count FROM interested), 
    CASE WHEN (SELECT count FROM assigned) > 0 THEN ROUND((SELECT count FROM interested)::numeric / (SELECT count FROM assigned) * 100, 1) ELSE 0 END
  UNION ALL
  SELECT 'Received', (SELECT count FROM received), 
    CASE WHEN (SELECT count FROM assigned) > 0 THEN ROUND((SELECT count FROM received)::numeric / (SELECT count FROM assigned) * 100, 1) ELSE 0 END;
END;
$$ LANGUAGE plpgsql;

-- 7. Get FRO Performance for Dashboard
CREATE OR REPLACE FUNCTION get_fro_performance_summary(p_ngo_ids INT[])
RETURNS TABLE(
  fro_id UUID,
  fro_name TEXT,
  collection_amount NUMERIC,
  lead_done_count INT,
  data_connected INT,
  data_total INT,
  conversion_pct NUMERIC,
  target_amount NUMERIC,
  target_pct NUMERIC,
  status TEXT,
  idle_minutes INT,
  claims_pending INT,
  claims_verified INT,
  claims_rejected INT
) AS $$
DECLARE
  v_worker_ids UUID[];
  v_month_start TIMESTAMPTZ;
  v_month_end TIMESTAMPTZ;
  v_today_start TIMESTAMPTZ;
  v_today_end TIMESTAMPTZ;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Get worker IDs for these NGOs
  SELECT ARRAY_AGG(DISTINCT w.id) INTO v_worker_ids
  FROM workers w
  JOIN worker_ngo_allocations wna ON w.id = wna.worker_id
  WHERE w.department = 'FRO' AND w.is_active = true
    AND wna.ngo_id = ANY(p_ngo_ids);
  
  IF v_worker_ids IS NULL OR array_length(v_worker_ids, 1) = 0 THEN
    RETURN;
  END IF;

  v_month_start := date_trunc('month', v_now)::timestamptz;
  v_month_end := (date_trunc('month', v_now) + interval '1 month - 1 second')::timestamptz;
  v_today_start := date_trunc('day', v_now)::timestamptz;
  v_today_end := (v_today_start + interval '1 day - 1 second')::timestamptz;

  RETURN QUERY
  WITH batch_stats AS (
    SELECT 
      l.fro_worker_id,
      SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified') as month_collection,
      SUM(l.amount_collected) FILTER (WHERE l.accounts_status = 'verified' AND l.created_at >= v_today_start AND l.created_at <= v_today_end) as today_collection,
      COUNT(*) FILTER (WHERE l.accounts_status = 'verified' AND l.created_at >= v_month_start AND l.created_at <= v_month_end) as verified_month_count,
      COUNT(*) FILTER (WHERE l.accounts_status = 'pending' AND l.created_at >= v_month_start AND l.created_at <= v_month_end) as unverified_month_count,
      COUNT(*) FILTER (WHERE l.accounts_status = 'verified' AND l.created_at >= v_today_start AND l.created_at <= v_today_end) as verified_today_count,
      COUNT(*) FILTER (WHERE l.accounts_status = 'pending' AND l.created_at >= v_today_start AND l.created_at <= v_today_end) as unverified_today_count
    FROM fro_donor_logs l
    JOIN fro_assignments a ON l.assignment_id = a.id
    WHERE l.fro_worker_id = ANY(v_worker_ids)
      AND a.ngo_id = ANY(p_ngo_ids)
      AND l.created_at >= v_month_start AND l.created_at <= v_month_end
    GROUP BY l.fro_worker_id
  ),
  worker_assignments AS (
    SELECT 
      fa.fro_worker_id,
      COUNT(*) FILTER (WHERE fa.status IN ('contacted', 'lead_done', 'done', 'donation_collected', 'follow_up', 'scheduled', 'visit_donate', 'will_donate_online', 'promise_to_pay', 'payment_pending', 'already_donated', 'email_sent', 'whatsapp_sent', 'csr_inquiry', 'wants_80g_details', 'wants_trust_documents', 'language_barrier', 'transferred_senior', 'query_complaint', 'receipt_request', 'not_interested_now', 'not_interested', 'dnd', 'wrong_person', 'call_disconnected', 'callback')) as connected,
      COUNT(*) as total
    FROM fro_assignments fa
    WHERE fa.fro_worker_id = ANY(v_worker_ids)
      AND fa.ngo_id = ANY(p_ngo_ids)
      AND fa.status != 'reassigned'
    GROUP BY fa.fro_worker_id
  ),
  claim_status AS (
    SELECT 
      l.fro_worker_id,
      COUNT(*) FILTER (WHERE l.accounts_status = 'pending') as claims_pending,
      COUNT(*) FILTER (WHERE l.accounts_status = 'verified') as claims_verified,
      COUNT(*) FILTER (WHERE l.accounts_status = 'rejected') as claims_rejected
    FROM fro_donor_logs l
    JOIN fro_assignments a ON l.assignment_id = a.id
    WHERE l.fro_worker_id = ANY(v_worker_ids)
      AND a.ngo_id = ANY(p_ngo_ids)
    GROUP BY l.fro_worker_id
  ),
  live_status AS (
    SELECT fro_worker_id, status, updated_at, today_talk_seconds, today_idle_seconds
    FROM fro_live_status
    WHERE fro_worker_id = ANY(v_worker_ids)
  ),
  targets AS (
    SELECT fro_worker_id, target_amount, achieved_target
    FROM fro_targets
    WHERE month = date_trunc('month', v_now)::date
      AND fro_worker_id = ANY(v_worker_ids)
  )
  SELECT 
    w.id as fro_id,
    w.name as fro_name,
    COALESCE(bs.month_collection, 0) as collection_amount,
    COALESCE(bs.verified_month_count, 0) + COALESCE(bs.unverified_month_count, 0) as lead_done_count,
    COALESCE(wa.connected, 0) as data_connected,
    COALESCE(wa.total, 0) as data_total,
    CASE WHEN COALESCE(wa.total, 0) > 0 THEN ROUND((COALESCE(wa.connected, 0)::numeric / wa.total) * 100, 1) ELSE 0 END as conversion_pct,
    COALESCE(t.target_amount, 0) as target_amount,
    CASE WHEN COALESCE(t.target_amount, 0) > 0 
      THEN ROUND((COALESCE(t.achieved_target, COALESCE(bs.month_collection, 0)) / COALESCE(t.target_amount, 1)) * 100, 1) 
      ELSE 0 END as target_pct,
    COALESCE(ls.status, 'offline') as status,
    CASE WHEN ls.updated_at IS NOT NULL THEN EXTRACT(EPOCH FROM (v_now - ls.updated_at)) / 60 ELSE 0 END as idle_minutes,
    COALESCE(cs.claims_pending, 0) as claims_pending,
    COALESCE(cs.claims_verified, 0) as claims_verified,
    COALESCE(cs.claims_rejected, 0) as claims_rejected
  FROM workers w
  LEFT JOIN batch_stats bs ON w.id = bs.fro_worker_id
  LEFT JOIN worker_assignments wa ON w.id = wa.fro_worker_id
  LEFT JOIN claim_status cs ON w.id = cs.fro_worker_id
  LEFT JOIN live_status ls ON w.id = ls.fro_worker_id
  LEFT JOIN targets t ON w.id = t.fro_worker_id
  WHERE w.id = ANY(v_worker_ids);
END;
$$ LANGUAGE plpgsql;