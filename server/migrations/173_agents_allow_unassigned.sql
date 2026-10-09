-- Allow CRM agents to exist before an FRO is assigned to them, so admins can
-- bulk-create handles first and fill the Covers column later.
ALTER TABLE crm_agents ALTER COLUMN worker_id DROP NOT NULL;
