-- WhatsApp CRM enhancements (idempotent — safe to re-run)
-- 1) AI auto-reply settings + suggestions
-- 2) Broadcast campaigns + recipients
-- 3) Routing rules
-- 4) Interactive message payload column

CREATE TABLE IF NOT EXISTS whatsapp_ai_settings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_project text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'suggest' CHECK (mode IN ('auto', 'suggest')),
  system_prompt text,
  knowledge_base text,
  max_auto_replies integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_ai_suggestions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL,
  contact_id uuid,
  account_project text,
  inbound_message_id uuid,
  suggestion_text text NOT NULL,
  model text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text
);
CREATE INDEX IF NOT EXISTS idx_wa_ai_sugg_conv ON whatsapp_ai_suggestions(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_ai_sugg_status ON whatsapp_ai_suggestions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_broadcasts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  account_project text NOT NULL,
  template_name text NOT NULL,
  template_language text NOT NULL DEFAULT 'en',
  body_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled', 'failed')),
  total_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  rate_per_second integer NOT NULL DEFAULT 5,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS whatsapp_broadcast_recipients (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  broadcast_id integer NOT NULL REFERENCES whatsapp_broadcasts(id) ON DELETE CASCADE,
  contact_id uuid,
  phone text NOT NULL,
  wa_message_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  failure_reason text,
  sent_at timestamptz,
  status_updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_wa_bc_rcpt_bc ON whatsapp_broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_wa_bc_rcpt_wamid ON whatsapp_broadcast_recipients(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_wa_bc_rcpt_status ON whatsapp_broadcast_recipients(broadcast_id, status);

CREATE TABLE IF NOT EXISTS whatsapp_routing_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_project text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  match_type text NOT NULL DEFAULT 'keyword' CHECK (match_type IN ('keyword', 'any')),
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  assignee_id uuid NOT NULL,
  assignee_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_rules_proj ON whatsapp_routing_rules(account_project, priority);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS interactive_payload jsonb;
