-- 111: Add sender identity to ticket_replies so each reply shows which
-- panel/person sent it, and so replies can be shown only to the ticket raiser.

ALTER TABLE ticket_replies ADD COLUMN IF NOT EXISTS sender_name TEXT;
ALTER TABLE ticket_replies ADD COLUMN IF NOT EXISTS sender_panel TEXT;