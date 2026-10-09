-- ============================================================================
-- AUTO-CREDIT TARGET SUSPENSE RECEIPTS (37 of the 39 from the Aug-17 list)
-- Run on the EC2 with:  psql "$DATABASE_URL" -f auto_credit_target_list.sql
-- Or inside a psql session:  \i auto_credit_target_list.sql
--
-- What it does per matching receipt:
--   * UNCLAIMED (no log_id)          -> create donor (if missing), assignment,
--                                       verified fro_donor_logs, allocate
--                                       receipt_no, link receipt, credit totals
--   * CLAIMED + lead still pending   -> verify the lead, link receipt + no,
--                                       credit totals
--   * CLAIMED + lead already verified-> link receipt + no only (no double-credit)
--   * masked names (P***, E***)      -> skipped automatically
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Target payment IDs (edit this list to change the targets)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE target_pids (pid TEXT PRIMARY KEY);
INSERT INTO target_pids VALUES
  ('622929826124'),('105474568798'),('110459536372'),('312663885375'),
  ('063083760122'),('659500773344'),('128068602160'),('659545104407'),
  ('659546735798'),('659502277018'),('128070258233'),('659554536379'),
  ('961127221485'),('622944315482'),('176803204530'),('110458792914'),
  ('804384143108'),('659519050846'),('128064986506'),('953051831428'),
  ('659501959551'),('659502267015'),('128064098115'),('659500560259'),
  ('312645629318'),('622935954873'),('659508532393'),('622916497636'),
  ('622992888007'),('659501653223'),('659502452471'),('659593324172'),
  ('110457804380'),('128055059182'),('128051248930'),('128050589448'),
  ('110456958858'),('110456833646'),('622910382655');

-- ---------------------------------------------------------------------------
-- 2) Main logic
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_donor_id        INTEGER;
  v_donor_new       BOOLEAN;
  v_worker_id       UUID;
  v_worker_name     TEXT;
  v_ngo_id          UUID;
  v_assignment_id   INTEGER;
  v_log_id          INTEGER;
  v_receipt_no      TEXT;
  v_skip            BOOLEAN;
  v_norm            TEXT;
  v_existing_log    INTEGER;
  v_upi             TEXT;
  v_log_status      TEXT;
  v_log_donor       INTEGER;
  v_old_total       NUMERIC;
BEGIN
  FOR r IN
    SELECT r.id, r.donor_name, r.donor_mobile, r.amount, r.receipt_date,
           r.receipt_time, r.project_id, r.payment_id, r.agent_name,
           r.mode, r.bank_payer_name, r.log_id
    FROM receipts r
    JOIN target_pids t ON upper(trim(r.payment_id)) = t.pid
    ORDER BY r.id
  LOOP
    v_skip := false;
    v_donor_id := NULL; v_worker_id := NULL; v_worker_name := NULL;
    v_ngo_id := NULL; v_assignment_id := NULL; v_log_id := NULL;

    -- Skip masked names (P*** / E***)
    IF r.donor_name ~ '[*?]' THEN
      RAISE NOTICE 'SKIP #% masked "%"', r.id, r.donor_name;
      CONTINUE;
    END IF;

    -- Skip receipts with no known NGO — never draw a number from the Being
    -- Sevak counter for a receipt whose NGO is unknown (that is what mis-credited
    -- Ashray receipts with Being Sevak numbers).
    IF r.project_id IS NULL OR r.project_id = '' THEN
      RAISE NOTICE 'SKIP #% no NGO "%"', r.id, r.donor_name;
      CONTINUE;
    END IF;

    -- Resolve worker from agent name (only if it is a real person)
    IF r.agent_name IS NOT NULL
       AND upper(trim(r.agent_name)) NOT IN ('', 'SUSPENSE', 'NA', 'N/A', 'NULL', '-') THEN
      SELECT w.id, w.name INTO v_worker_id, v_worker_name
      FROM workers w
      WHERE regexp_replace(lower(trim(w.name)), '\s+', ' ', 'g')
          = regexp_replace(lower(trim(r.agent_name)), '\s+', ' ', 'g')
      ORDER BY w.id LIMIT 1;
    END IF;

    -- Resolve NGO id from project code
    SELECT n.id INTO v_ngo_id FROM ngos n
    WHERE lower(trim(n.name)) = lower(trim(r.project_id)) LIMIT 1;

    IF r.log_id IS NOT NULL THEN
      -- ======================= CLAIMED RECEIPT =======================
      SELECT l.accounts_status, l.donor_id INTO v_log_status, v_log_donor
      FROM fro_donor_logs l WHERE l.id = r.log_id;

      IF v_log_donor IS NULL THEN
        SELECT l.donor_id INTO v_log_donor FROM fro_donor_logs l WHERE l.id = r.log_id;
      END IF;

      IF v_log_status = 'verified' THEN
        -- Lead already verified: link the receipt only (no double credit)
        SELECT next_receipt_no(r.project_id) INTO v_receipt_no;
        UPDATE receipts
           SET donor_id = v_log_donor,
               log_id   = r.log_id,
               receipt_no = v_receipt_no,
               agent_name = COALESCE(NULLIF(trim(v_worker_name), ''), agent_name)
         WHERE id = r.id;
        RAISE NOTICE 'LINKED #% (existing verified lead) donor=% no=%', r.id, v_log_donor, v_receipt_no;
      ELSE
        -- Lead pending: verify it + link receipt + credit totals
        UPDATE fro_donor_logs
           SET accounts_status = 'verified', verified_at = NOW()
         WHERE id = r.log_id;
        UPDATE fro_assignments
           SET status = 'donation_collected', last_contacted_at = NOW()
         WHERE id = (SELECT assignment_id FROM fro_donor_logs WHERE id = r.log_id);

        SELECT next_receipt_no(r.project_id) INTO v_receipt_no;
        UPDATE receipts
           SET donor_id = v_log_donor,
               log_id   = r.log_id,
               receipt_no = v_receipt_no,
               agent_name = COALESCE(NULLIF(trim(v_worker_name), ''), agent_name)
         WHERE id = r.id;

        UPDATE donor_profiles
           SET total_amount = ROUND((COALESCE(total_amount,0) + r.amount)::numeric, 2),
               donation_count = COALESCE(donation_count, 0) + 1,
               last_donation_date = GREATEST(COALESCE(last_donation_date, '1000-01-01'::date), r.receipt_date),
               updated_at = NOW()
         WHERE id = v_log_donor;
        RAISE NOTICE 'VERIFIED+CREDITED #% donor=% no=%', r.id, v_log_donor, v_receipt_no;
      END IF;
      v_log_id := r.log_id;
    ELSE
      -- ======================= UNCLAIMED RECEIPT =======================
      -- Find or create donor profile
      SELECT d.id INTO v_donor_id
      FROM donor_profiles d
      WHERE regexp_replace(lower(trim(d.name)), '\s+', ' ', 'g')
          = regexp_replace(lower(trim(r.donor_name)), '\s+', ' ', 'g')
      ORDER BY d.id LIMIT 1;

      IF v_donor_id IS NULL THEN
        SELECT d.id INTO v_donor_id
        FROM donor_profiles d
        WHERE regexp_replace(lower(trim(d.name)), '\s+', ' ', 'g')
            LIKE regexp_replace(lower(trim(r.donor_name)), '\s+', ' ', 'g')
        ORDER BY d.id LIMIT 1;
      END IF;

      IF v_donor_id IS NULL THEN
        INSERT INTO donor_profiles (name, mobile_number, project_supported, created_at, updated_at)
        VALUES (r.donor_name, 'NOCELL-' || floor(extract(epoch FROM NOW()) * 1000)::bigint,
                r.project_id, NOW(), NOW())
        RETURNING id INTO v_donor_id;
        v_donor_new := true;
      ELSE
        v_donor_new := false;
      END IF;

      -- Reuse an existing verified log with the same UPI id if one exists
      v_upi := upper(trim(COALESCE(r.payment_id, '')));
      IF v_upi <> '' THEN
        SELECT l.id INTO v_existing_log FROM fro_donor_logs l
        WHERE upper(trim(COALESCE(l.upi_transaction_id, ''))) = v_upi
        ORDER BY l.id LIMIT 1;
      ELSE
        v_existing_log := NULL;
      END IF;

      IF v_existing_log IS NOT NULL THEN
        v_log_id := v_existing_log;
      ELSE
        -- Ensure an assignment exists
        SELECT a.id INTO v_assignment_id FROM fro_assignments a
        WHERE a.donor_id = v_donor_id
          AND (v_worker_id IS NULL OR a.fro_worker_id = v_worker_id)
          AND (v_ngo_id IS NULL OR a.ngo_id = v_ngo_id)
        ORDER BY a.id LIMIT 1;

        IF v_assignment_id IS NULL THEN
          INSERT INTO fro_assignments (donor_id, fro_worker_id, ngo_id, status, assigned_at)
          VALUES (v_donor_id, v_worker_id, v_ngo_id, 'donation_collected', NOW())
          RETURNING id INTO v_assignment_id;
        END IF;

        INSERT INTO fro_donor_logs
          (assignment_id, donor_id, fro_worker_id, action, disposition_detail,
           amount_collected, accounts_status, upi_transaction_id, payment_mode,
           payment_from, transaction_datetime, verified_at, created_at, created_by)
        VALUES
          (v_assignment_id, v_donor_id, v_worker_id, 'disposition', 'lead_done',
           r.amount, 'verified', r.payment_id,
           COALESCE(r.mode, 'UPI'), COALESCE(r.bank_payer_name, r.donor_name),
           COALESCE((r.receipt_date::text || ' ' || COALESCE(r.receipt_time, '00:00'))::timestamp, r.receipt_date::timestamp),
           NOW(), NOW(), v_worker_id)
        RETURNING id INTO v_log_id;
      END IF;

      -- Allocate receipt number + link receipt
      SELECT next_receipt_no(r.project_id) INTO v_receipt_no;
      UPDATE receipts
         SET donor_id = v_donor_id,
             log_id   = v_log_id,
             receipt_no = v_receipt_no,
             agent_name = COALESCE(NULLIF(trim(v_worker_name), ''), agent_name)
       WHERE id = r.id;

      -- Credit donor totals
      UPDATE donor_profiles
         SET total_amount = ROUND((COALESCE(total_amount,0) + r.amount)::numeric, 2),
             donation_count = COALESCE(donation_count, 0) + 1,
             last_donation_date = GREATEST(COALESCE(last_donation_date, '1000-01-01'::date), r.receipt_date),
             updated_at = NOW()
       WHERE id = v_donor_id;

      RAISE NOTICE 'CREDITED #% donor=% (new=%) log=% no=%', r.id, v_donor_id, v_donor_new, v_log_id, v_receipt_no;
    END IF;

    -- Settle the bank audit entry (match by UPI or receipt_id)
    v_upi := upper(trim(COALESCE(r.payment_id, '')));
    IF v_upi <> '' THEN
      UPDATE bank_audit_entries
         SET status = 'verified',
             donor_id = COALESCE(v_donor_id, v_log_donor),
             matched_lead_log_id = v_log_id,
             match_status = 'confirmed',
             receipt_id = r.id,
             receipt_no = v_receipt_no,
             matched_at = NOW(), updated_at = NOW()
       WHERE upper(trim(COALESCE(payment_id, ''))) = v_upi
          OR receipt_id = r.id;
    END IF;
  END LOOP;
END $$;

DROP TABLE target_pids;

-- ---------------------------------------------------------------------------
-- 3) Verify (optional, run after to confirm)
-- ---------------------------------------------------------------------------
-- SELECT r.id, r.donor_name, r.donor_id, r.log_id, r.receipt_no, r.amount
-- FROM receipts r
-- JOIN target_pids t ... -- (table dropped above; use the ids inline if needed)

COMMIT;