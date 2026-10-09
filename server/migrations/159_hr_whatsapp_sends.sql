-- 159: HR WhatsApp sending — audit log + the two approved-template name slots.
--
-- HR > Letters sends real Meta Cloud API messages from the "ucs" account in
-- whatsapp_accounts. Two things are recorded here:
--
--   hr_whatsapp_sends   every send attempt, successful or not. Warning letters
--                       and terminations need an audit trail: who sent what, to
--                       which volunteer, through which account, and what Meta
--                       said. Failures are logged too — a warning that bounced
--                       because the volunteer never got it is exactly the case
--                       HR needs to see.
--
--   hr_*_template       The names of the Meta-approved templates the account
--                       should use when the volunteer is OUTSIDE the 24-hour
--                       customer-service window. Free-form sends work inside
--                       the window with no template at all; outside it Meta
--                       rejects everything (error 131009). These two columns
--                       are nullable on purpose: with them empty, the API
--                       returns an actionable "no template configured" error
--                       and the UI falls back to a manual wa.me link, rather
--                       than failing with an opaque Meta error.
--
-- `send_mode` records which branch actually ran, so you can tell at a glance
-- whether a given volunteer is reachable for free-form sends:
--   'session'  free-form send, inside the 24h window
--   'template' approved-template send, outside the window
--
-- These are separate from the `messages` / `conversations` tables: those drive
-- the donor-facing FRO inbox, and HR letters to volunteers do not belong in it.

CREATE TABLE IF NOT EXISTS hr_whatsapp_sends (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: a log row outlives the volunteer record, and HR may also want to
  -- message a number that is not tied to a worker at all.
  worker_id             UUID REFERENCES workers(id) ON DELETE SET NULL,
  -- Name snapshot. The Letters page keys volunteers by name, and a rename
  -- should not rewrite history.
  worker_name           TEXT,
  -- 'text' for the warning-message templates, 'document' for a letter PDF.
  channel               TEXT NOT NULL CHECK (channel IN ('text', 'document')),
  -- Letter type (e.g. 'Warning letter') for document sends.
  letter_type           TEXT,
  -- HR_MESSAGES key (m1..m7) for text sends.
  message_key           TEXT,
  -- First part of what went out, so the log is readable without opening Meta.
  body_preview          TEXT,
  to_phone              TEXT,
  -- Meta's wamid, for reconciling delivery status later.
  wa_message_id         TEXT,
  send_mode             TEXT CHECK (send_mode IN ('session', 'template')),
  status                TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  -- Meta's own error text on failure, so the reason survives in the log.
  error_message         TEXT,
  -- Left as TEXT, not a users(id) FK: the JWT subject is written as a string
  -- everywhere else in this codebase (messages.user_id, receipts.created_by).
  sent_by               TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- whatsapp_accounts was created by hand, not by a migration, so its `id` type
-- is not knowable from the repo — it is uuid in Supabase-created tables but
-- bigserial/serial in plenty of hand-written ones. A hardcoded UUID here fails
-- with `foreign key constraint "hr_whatsapp_sends_whatsapp_account_id_fkey"
-- cannot be implemented` the moment the guess is wrong, so read the real type
-- out of the catalog and build the column + constraint from it.
DO $$
DECLARE
  acct_type   text;
  acct_is_key boolean;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO acct_type
  FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'whatsapp_accounts'
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF acct_type IS NULL THEN
    RAISE EXCEPTION
      'whatsapp_accounts has no "id" column, so hr_whatsapp_sends cannot record which account sent a message. Check the table exists in this database and what its key column is called.';
  END IF;

  -- A foreign key needs a unique/PK target. If the hand-made table has a
  -- plain non-unique `id`, say so plainly rather than emitting Postgres's
  -- terse "cannot be implemented".
  SELECT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'whatsapp_accounts'::regclass
      AND i.indisunique
      AND i.indnatts = 1
      AND i.indkey[0] = (
        SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid = 'whatsapp_accounts'::regclass AND a.attname = 'id'
      )
  ) INTO acct_is_key;

  IF NOT acct_is_key THEN
    RAISE EXCEPTION
      'whatsapp_accounts.id is not unique (no primary key or unique index), so it cannot be a foreign key target. Add a unique constraint before applying this migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'hr_whatsapp_sends'
      AND column_name  = 'whatsapp_account_id'
  ) THEN
    EXECUTE format(
      'ALTER TABLE hr_whatsapp_sends ADD COLUMN whatsapp_account_id %s', acct_type
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hr_whatsapp_sends_whatsapp_account_id_fkey'
  ) THEN
    EXECUTE format(
      'ALTER TABLE hr_whatsapp_sends
         ADD CONSTRAINT hr_whatsapp_sends_whatsapp_account_id_fkey
         FOREIGN KEY (whatsapp_account_id) REFERENCES whatsapp_accounts(id) ON DELETE SET NULL'
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hr_whatsapp_sends_created_at
  ON hr_whatsapp_sends (created_at DESC);

-- Drives the per-volunteer "sent on WhatsApp" history on the Letters page.
CREATE INDEX IF NOT EXISTS idx_hr_whatsapp_sends_worker
  ON hr_whatsapp_sends (worker_id, created_at DESC);

ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS hr_letter_template TEXT;
ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS hr_warning_template TEXT;
