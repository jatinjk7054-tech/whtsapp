-- 172: CRM login agents ("Agent N").
--
-- A login agent is a person who works a Field Relationship Officer's data
-- without ever holding the FRO's own credentials. An admin creates the agent,
-- assigns exactly one FRO, and the agent signs in with the generated
-- login_id / password. From then on every FRO surface behaves as though the FRO
-- were sitting at the keyboard: the NGO-admin performance board shows the FRO
-- online, their idle/call/talk figures accrue to them, and receipts raised by
-- the agent are stamped with the agent label but credited back to the FRO.
--
-- Deliberately its own table rather than reusing users.role='agent' or
-- worker_agent_assignments:
--   - users already holds 59 role='agent' rows. Those are real WhatsApp agent
--     accounts, resolved by froWhatsAppService when routing conversations -- not
--     CRM logins. Repurposing that role would collide with live data.
--   - worker_agent_assignments carries FKs on user_id -> users(id) and is the
--     WhatsApp agent<->account routing table. Login agents have no row in
--     users, and writing them here would make them receive other people's
--     WhatsApp traffic.
--
-- The agent's own uuid deliberately appears nowhere in `workers`. Live rows and
-- time sessions both carry FKs to workers(id), so an agent session files its
-- heartbeat under the ASSIGNED FRO's worker id (see splitWorkerContext in
-- backend/src/utils/workAs.js). That keeps the FRO's row authoritative and
-- satisfies those foreign keys; the cover relationship itself is still recorded
-- in work_as_sessions, which has no FK on operator_user_id and holds any id.

CREATE TABLE IF NOT EXISTS crm_agents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Immutable handle. Allocated sequentially as agent1, agent2, ... and never
  -- reused, so an audit trail naming "Agent 2" can never drift onto a new person.
  login_id              text NOT NULL,
  -- bcrypt only. The plaintext is returned exactly once, at creation or reset.
  password_hash         text NOT NULL,
  -- What the agent is called in the UI and on receipts ("Agent 2"). Also written
  -- into worker_aliases so collection totals resolve the label back to the FRO.
  label                 text NOT NULL,
  -- The one FRO this agent works. CASCADE: deleting the FRO removes the agent.
  worker_id             uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  ngo_id                uuid REFERENCES ngos(id) ON DELETE SET NULL,
  is_active             boolean NOT NULL DEFAULT true,
  -- Off by default: agents ship with the admin-chosen default password. Flip it
  -- per agent to force a change at next login.
  must_change_password  boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive: "Agent2" and "agent2" must not become two different agents.
CREATE UNIQUE INDEX IF NOT EXISTS crm_agents_login_id_uniq
  ON crm_agents (lower(login_id));

-- One active agent per FRO, enforcing the 1:1. Partial rather than absolute so a
-- deactivated agent leaves an audit trail instead of blocking reassignment of
-- the FRO to somebody else.
CREATE UNIQUE INDEX IF NOT EXISTS crm_agents_worker_uniq
  ON crm_agents (worker_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_crm_agents_worker ON crm_agents (worker_id);
CREATE INDEX IF NOT EXISTS idx_crm_agents_ngo    ON crm_agents (ngo_id);
CREATE INDEX IF NOT EXISTS idx_crm_agents_active ON crm_agents (is_active);

-- Allocator for those sequential handles. A single row that is incremented with
-- UPDATE ... RETURNING inside the creation transaction, which row-locks it: two
-- admins creating an agent at the same moment serialise here instead of both
-- computing the same number and one losing the race to the unique index.
--
-- Deliberately a consumed counter and not "max(existing) + 1": a number is burned
-- even if the surrounding transaction rolls back. That is the point. If the same
-- handle were reissued after a failure, an audit trail naming "Agent 2" could
-- quietly come to mean two different people.
CREATE TABLE IF NOT EXISTS crm_agent_sequence (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_value  integer NOT NULL DEFAULT 0
);

INSERT INTO crm_agent_sequence (id, last_value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;