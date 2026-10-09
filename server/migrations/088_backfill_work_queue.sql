-- 088: Backfill work_queue to reflect donors already terminally disposed before
-- the controlled queue went live.
--
-- work_queue is seeded lazily (rows appear the first time a FRO opens the
-- queue). Any donor this worker already dispositioned terminally should be
-- marked DISPOSED so the queue reflects reality and those leads can never
-- reappear as workable. The retryable not-connected set below MUST match
-- retryableNotConnectedDates in backend/src/models/workQueueModel.js
-- (classifyDisposition): those keep the donor active; every other disposition
-- (including money events and scheduled/callback) is terminal for the queue.
--
-- Idempotent: only touches rows still active (PENDING / IN_PROGRESS /
-- BUTTON_PRESSED) and leaves already-DISPOSED/COMPLETED/EXCEPTION rows alone.

UPDATE work_queue wq
SET status      = 'DISPOSED',
    disposed_at = COALESCE(
        (SELECT MAX(l.created_at) FROM fro_donor_logs l
          WHERE l.donor_id    = wq.donor_id
            AND l.fro_worker_id = wq.worker_id
            AND ( (l.action = 'disposition' AND l.disposition_detail IS NOT NULL
                   AND l.disposition_detail NOT IN
                     ('ringing','unreachable','busy','out_of_coverage',
                      'voicemail','call_waiting','switched_off'))
                  OR l.action = 'donation' )),
        wq.disposed_at),
    updated_at  = now()
WHERE wq.status IN ('PENDING','IN_PROGRESS','BUTTON_PRESSED')
  AND EXISTS (
    SELECT 1 FROM fro_donor_logs l
    WHERE l.donor_id    = wq.donor_id
      AND l.fro_worker_id = wq.worker_id
      AND ( (l.action = 'disposition' AND l.disposition_detail IS NOT NULL
             AND l.disposition_detail NOT IN
               ('ringing','unreachable','busy','out_of_coverage',
                'voicemail','call_waiting','switched_off'))
            OR l.action = 'donation' )
  );
