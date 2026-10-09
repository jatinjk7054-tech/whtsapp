-- 153: Remove HR-inactive volunteers from the events they were already assigned to.
--
-- The Voluntary list of an event stores { id?, name, ngo, team } entries. When
-- somebody is marked absconded (or offboarded / deactivated) in the HR panel,
-- they must stop appearing on the events they had been selected for, without
-- anyone having to re-open and re-save every event.
--
-- The server already hides these on read (pruneInactiveVolunteers in
-- eventHeadController.js) and rewrites the row on the next save. This migration
-- heals the rows that are never opened again.

--
-- Only "Volunteer" entries are pruned. Management names come from the HR
-- employees file, not the workers table, so they are never matched. An entry is
-- dropped only when it positively matches a worker the HR panel has marked
-- inactive — by id when the entry has one, otherwise by normalised name. A name
-- matching no worker at all is left untouched rather than silently deleted.
--
-- Idempotent: re-running finds nothing left to prune.
WITH inactive_workers AS (
  SELECT
    w.id::text AS id,
    lower(regexp_replace(btrim(COALESCE(w.name, '')), '\s+', ' ', 'g')) AS name_key
  FROM workers w
  WHERE w.is_test IS NOT TRUE
    AND w.is_active IS FALSE
    AND COALESCE(w.employment_status, '') <> 'active'
),
pruned AS (
  SELECT
    e.id,
    COALESCE(
      (
        SELECT jsonb_agg(vol.value)
        FROM jsonb_array_elements(COALESCE(e.volunteers, '[]'::jsonb)) AS vol(value)
        WHERE NOT (
          COALESCE(vol.value->>'team', 'Volunteer') <> 'Management'
          AND (
            (
              (vol.value->>'id') IS NOT NULL
              AND (vol.value->>'id') IN (SELECT id FROM inactive_workers)
            )
            OR
            (
              (vol.value->>'id') IS NULL
              AND lower(regexp_replace(btrim(COALESCE(vol.value->>'name', '')), '\s+', ' ', 'g'))
                IN (SELECT name_key FROM inactive_workers WHERE name_key <> '')
            )
          )
        )
      ),
      '[]'::jsonb
    ) AS volunteers
  FROM event_head_events e
  WHERE jsonb_typeof(e.volunteers) = 'array'
)
UPDATE event_head_events e
SET volunteers = p.volunteers
FROM pruned p
WHERE e.id = p.id
  AND p.volunteers IS DISTINCT FROM e.volunteers;
