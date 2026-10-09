-- One CRM login agent for every FRO worker. No filters: every row in workers
-- with department containing 'fro' gets an agent, even if inactive or
-- terminated. Existing rows are replaced, not duplicated.
-- Run in a transaction; review the DELETE first.

BEGIN;

-- Wipe old generated data so the re-seed is clean.
DELETE FROM worker_aliases WHERE alias_name ~ '^Agent [0-9]+$';
DELETE FROM crm_agents;

WITH fros AS (
  SELECT w.id, w.ngo_id, w.name,
         ROW_NUMBER() OVER (ORDER BY w.name) AS rn
  FROM workers w
  WHERE lower(btrim(coalesce(w.department, ''))) = 'fro'
),
numbered AS (
  SELECT f.*,
         ROW_NUMBER() OVER (ORDER BY rn) AS n
  FROM fros f
),
inserted AS (
  INSERT INTO crm_agents (login_id, label, worker_id, ngo_id, password_hash, is_active, must_change_password)
  SELECT 'agent' || n, 'Agent ' || n, id, ngo_id,
         '$2a$10$bR2kKzrsK0mP9i4BDIuNkuN1GTid9WfcNvoX2rbvZtp0dDjkAyroq', true, false
  FROM numbered
  RETURNING id, label, worker_id
)
INSERT INTO worker_aliases (alias_name, worker_id)
SELECT i.label, i.worker_id FROM inserted i;

UPDATE crm_agent_sequence
SET last_value = (SELECT COUNT(*) FROM crm_agents)
WHERE id = 1;

COMMIT;
