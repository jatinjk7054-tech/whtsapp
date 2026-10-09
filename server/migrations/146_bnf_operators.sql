-- 146: Beneficiaries mobile-app operators.
-- Workers flagged bnf_operator = true are the ONLY accounts allowed to log
-- into the Beneficiaries mobile app (enforced in /auth/worker/login when the
-- request declares client = 'beneficiaries'). phone is a friendly contact
-- field for field operators. Idempotent: safe to re-run.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS bnf_operator BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS phone TEXT;