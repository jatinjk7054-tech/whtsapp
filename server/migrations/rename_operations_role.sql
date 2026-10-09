-- =====================================================================
-- Rename metropad role role-value 'OPERATIONS' -> 'OPERATOR'
-- Run in Supabase SQL Editor (Production) -- NOT the local dev DB.
--
-- IMPORTANT: Patch the backend FIRST so it expects 'OPERATOR' (metropad
-- routes authorize('ADMIN','OPERATOR'), user.service VALID_ROLES =
-- ['ADMIN','OPERATOR','VIEWER']). Otherwise operators keep DB role
-- 'OPERATIONS' which the new guards reject -> they lock out.
--
-- metropad_users.role is a Postgres ENUM (user_role), so it is NOT a
-- plain UPDATE: the enum has no 'OPERATOR' value yet. Because Postgres
-- forbids ALTER TYPE ... ADD VALUE from sharing a transaction with any
-- other statement, run the two blocks as SEPARATE executions (step 1
-- alone, then step 2, then step 3 verify). Do NOT paste all three at once.
-- =====================================================================

-- ---------------------------------------------------------------
-- STEP 1 -- ALTER TYPE ADD VALUE
-- Run this ALONE (own execution), it cannot share a transaction
-- with the UPDATE below.
-- Added to the END of the user_role enum because ADD VALUE cannot
-- reorder; placement does not matter for equality comparisons.
-- ---------------------------------------------------------------
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'OPERATOR';

-- ---------------------------------------------------------------
-- STEP 2 -- RENAME rows (run AFTER step 1 success, alone or after)
-- Only metropad_users.role is changed. Nothing else is touched.
-- ---------------------------------------------------------------
UPDATE metropad_users
SET role = 'OPERATOR'
WHERE role = 'OPERATIONS';

-- ---------------------------------------------------------------
-- STEP 3 -- VERIFY -- should now show only ADMIN, OPERATOR, VIEWER
-- and the 'OPERATIONS' row count below should be gone.
-- ---------------------------------------------------------------
SELECT role, COUNT(*) AS rows
FROM metropad_users
GROUP BY role
ORDER BY role;

-- ---------------------------------------------------------------
-- STEP 4 (OPTIONAL) -- once step 3 confirms zero 'OPERATIONS' rows,
-- drop the obsolete enum member so future inserts can never use it.
-- Postgres 12+. Has its own ADD-then-DROP quirks; if you hit a lock
-- issue, just re-run. Skidding-safe no-op ordering enforced by the
-- WHERE above.
-- ---------------------------------------------------------------
-- ALTER TYPE user_role DROP VALUE 'OPERATIONS';
