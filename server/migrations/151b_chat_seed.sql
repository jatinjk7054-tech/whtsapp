-- 151b: Community Chat seed.
--
-- OPTIONAL. The backend already does all of this in
-- backend/src/bootstrap/ensureChatSchema.js on every boot, so you do not need
-- to run this file - just restart the server.
--
-- WHO IS A MEMBER: only panel staff, i.e. rows in `workers` whose department
-- maps to one of the eight panels. The `users` table is the CRM side
-- (`agent` / `admin`) and is NOT part of chat: CRM agents have no Community
-- page anywhere in the UI. Departments that map to no panel
-- (Housekeeping, operator) are excluded too.
--
-- Keep the CASE expression below in step with the one in
-- backend/src/models/chatModel.js (listCommunityCandidates) and with
-- department -> role in authController.js - all three must agree, or someone
-- gets a second, empty participant row under a different key.
--
-- The Super Admin is NOT in `workers`; they log in from ADMIN_EMAIL. That row
-- is added by ensureChatSchema.js at boot because only it can read .env.
--
-- Safe to re-run: ON CONFLICT DO UPDATE.

-- 1. The single Community room.
INSERT INTO chat_conversations (kind, slug, title, created_by)
VALUES ('group', 'community', 'Community', 'system')
ON CONFLICT (slug) DO NOTHING;

-- 2. Every active panel staff member as a participant.
--    Writers are Accounts + Super Admin, so `department = 'Admin'` is the only
--    writer here; everyone else is read-only.
INSERT INTO chat_participants
  (conversation_id, uid, subject_id, role, can_post, display_name, email, ngo_id)
SELECT
  c.id,
  -- Workers authenticate with login_id and their JWT carries no email, so the
  -- stable key is the row id. Matches chatUidFor().
  'login:' || w.id,
  w.id::text,
  -- authController.js department -> role mapping.
  CASE
    WHEN btrim(lower(w.department)) = 'hr'                                          THEN 'hr'
    WHEN btrim(lower(w.department)) LIKE '%recruit%'                                THEN 'recruiter'
    WHEN btrim(lower(w.department)) = 'admin'                                       THEN 'accounts'
    WHEN btrim(lower(w.department)) = 'fro'                                         THEN 'fro'
    WHEN btrim(lower(w.department)) = 'ngo admin'                                   THEN 'admin'
    WHEN btrim(lower(w.department)) = 'digital'
      OR btrim(lower(w.department)) LIKE '%develop%'                                THEN 'digital'
    WHEN btrim(lower(w.department)) LIKE '%event%'                                  THEN 'event_head'
    ELSE 'worker'
  END,
  btrim(lower(w.department)) = 'admin',
  COALESCE(NULLIF(btrim(w.name), ''), NULLIF(btrim(w.login_id), ''), 'User ' || w.id),
  NULLIF(btrim(lower(w.email)), ''),
  w.ngo_id
FROM chat_conversations c
CROSS JOIN workers w
WHERE c.slug = 'community'
  AND COALESCE(w.is_active, true) = true
  AND w.employment_status IS DISTINCT FROM 'terminated'
  -- "Department maps to one of the eight panels", which is the set of exact
  -- departments authController.js names plus the substring rules it uses.
  AND (
       btrim(lower(w.department)) IN
         ('hr', 'admin', 'fro', 'ngo admin', 'digital', 'accounts', 'account')
    OR btrim(lower(w.department)) LIKE '%recruit%'
    OR btrim(lower(w.department)) LIKE '%develop%'
    OR btrim(lower(w.department)) LIKE '%event%'
  )
ON CONFLICT (conversation_id, uid) DO UPDATE
  SET subject_id   = EXCLUDED.subject_id,
      role         = EXCLUDED.role,
      can_post     = EXCLUDED.can_post,
      display_name = EXCLUDED.display_name,
      email        = EXCLUDED.email,
      ngo_id       = EXCLUDED.ngo_id;

-- 3. Drop the CRM users this file no longer seats. Without this, a manual run
--    on a database that an older seeder already touched would leave one
--    `email:` participant row per CRM agent, and those rows would keep matching
--    nothing - invisible, but still counted, and they would wrongly satisfy
--    the reader-eligibility check.
DELETE FROM chat_participants p
USING chat_conversations c
WHERE p.conversation_id = c.id
  AND c.slug = 'community'
  AND p.uid LIKE 'email:%';

-- 4. Confirm. Expect ~69 panel staff, 2 writers from `workers`, plus the
--    Super Admin row that ensureChatSchema.js adds at boot.
SELECT
  (SELECT count(*) FROM chat_conversations WHERE slug = 'community')      AS community_rooms,
  (SELECT count(*) FROM chat_participants
     WHERE conversation_id = (SELECT id FROM chat_conversations WHERE slug = 'community')
   )                                                                     AS participants,
  (SELECT count(*) FROM chat_participants WHERE can_post)                 AS writers,
  (SELECT count(*) FROM chat_messages)                                   AS messages;
