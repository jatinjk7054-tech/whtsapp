-- 109: Create ticket tables (if missing) and add desk_number + ngo columns.
-- support_tickets and developer_tickets may have been created manually;
-- this migration ensures they exist with the expected schema, then adds
-- the new desk_number and ngo columns.

-- ═══ support_tickets ═══
CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raised_by     UUID REFERENCES workers(id),
  department    TEXT DEFAULT 'accounts',
  category      TEXT DEFAULT 'other',
  subject       TEXT NOT NULL,
  description   TEXT,
  reference_id  TEXT,
  priority      TEXT DEFAULT 'medium',
  status        TEXT DEFAULT 'open',
  resolution    TEXT,
  resolved_by   UUID,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS desk_number TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ngo TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS raised_by_panel TEXT;

-- ═══ ticket_replies ═══
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender_id   UUID,
  sender_type TEXT,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══ developer_tickets ═══
CREATE TABLE IF NOT EXISTS developer_tickets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raised_by           UUID REFERENCES workers(id),
  raised_by_name      TEXT,
  raised_by_panel     TEXT DEFAULT 'fro',
  assigned_to         UUID REFERENCES workers(id),
  subject             TEXT NOT NULL,
  description         TEXT,
  category            TEXT DEFAULT 'bug',
  priority            TEXT DEFAULT 'medium',
  reference_id        TEXT,
  status              TEXT DEFAULT 'open',
  resolution          TEXT,
  first_response_at   TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ
);

ALTER TABLE developer_tickets ADD COLUMN IF NOT EXISTS desk_number TEXT;
ALTER TABLE developer_tickets ADD COLUMN IF NOT EXISTS ngo TEXT;

-- ═══ developer_ticket_replies ═══
CREATE TABLE IF NOT EXISTS developer_ticket_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID REFERENCES developer_tickets(id) ON DELETE CASCADE,
  sender_id   UUID,
  sender_name TEXT,
  sender_panel TEXT,
  message     TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
    