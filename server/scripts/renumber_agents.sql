-- Renumber CRM agents to a dense 1..N sequence in plain FRO name order.
-- Also rewrites worker_aliases labels and re-syncs the sequence.
-- Run once; safe to re-run.

BEGIN;

-- Pass 1: move every row to a temporary unique id so the target names don't
-- collide with each other or the crm_agents_login_id_uniq index.
UPDATE crm_agents SET login_id = 'tmp-' || id, updated_at = now() WHERE is_active;

-- Drop the old generated alias labels; they are recreated below with the new
-- names. Anything that doesn't look like an auto-generated 'Agent N' row is
-- human-curated and is left alone.
DELETE FROM worker_aliases WHERE alias_name ~ '^Agent [0-9]+$';

-- Pass 2: dense, name-ordered numbering.
WITH ordered AS (
  SELECT a.id, a.worker_id,
         ROW_NUMBER() OVER (ORDER BY w.name) AS n
  FROM crm_agents a
  JOIN workers w ON w.id = a.worker_id
  WHERE a.is_active
),
renamed AS (
  UPDATE crm_agents a
     SET login_id = 'agent' || o.n,
         label    = 'Agent ' || o.n,
         updated_at = now()
    FROM ordered o
   WHERE a.id = o.id
  RETURNING a.id, a.worker_id, a.label
)
INSERT INTO worker_aliases (alias_name, worker_id)
SELECT label, worker_id FROM renamed;

UPDATE crm_agent_sequence
   SET last_value = (SELECT COUNT(*) FROM crm_agents WHERE is_active AND login_id ~ '^agent[0-9]+$')
 WHERE id = 1;

COMMIT;
