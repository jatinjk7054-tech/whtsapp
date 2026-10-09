-- Module 5 — customer tags.
--
-- Decision (customer-level, not conversation-level): the CRM treats one
-- WhatsApp number as one customer (contacts.wa_id is unique) and the Customer
-- Profile is contact-scoped, so tags live against the contact and follow it
-- across every conversation that contact has. `contact_tags` is the many-to-many
-- relationship table: a tag row is stored once and never duplicated inside a
-- contact or conversation record.
--
-- This file is applied by db/migrate.js after schema.sql (it references
-- contacts) and is also re-applied idempotently at server start by
-- tags/tag.repository.js seedTags(), so the tables exist even on a database
-- that was migrated before Module 5 shipped.

CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  -- Name is unique ignoring case: "donation" and "Donation" are one tag.
  name TEXT NOT NULL,
  -- Hex colour (#rrggbb). The five defaults are seeded in code so the palette
  -- can be changed without a migration.
  color TEXT NOT NULL DEFAULT '#6b7280',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_name_key ON tags (LOWER(name));

-- Relationship table: which tags are on which customer. Deleting a tag only
-- drops these links (ON DELETE CASCADE) — customers and conversations are
-- never touched.
CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id INTEGER NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
);

-- Drives the "show conversations with this tag" filter.
CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON contact_tags (tag_id);
