import db from '../config/db.js';

// Ticket schema bootstrap — idempotent re-application of the columns added by
// migrations 109 and 111 (desk_number / ngo / raised_by_panel on the ticket
// tables, and sender identity on ticket_replies). Re-runs safely on every boot
// via ADD COLUMN IF NOT EXISTS, so a fresh or partially-migrated DB is repaired
// automatically. Only ticket tables are touched; nothing else is read or changed.
const COLUMN_STEPS = [
  `ALTER TABLE support_tickets   ADD COLUMN IF NOT EXISTS desk_number     TEXT`,
  `ALTER TABLE support_tickets   ADD COLUMN IF NOT EXISTS ngo             TEXT`,
  `ALTER TABLE support_tickets   ADD COLUMN IF NOT EXISTS raised_by_panel TEXT`,
  `ALTER TABLE ticket_replies    ADD COLUMN IF NOT EXISTS sender_name     TEXT`,
  `ALTER TABLE ticket_replies    ADD COLUMN IF NOT EXISTS sender_panel    TEXT`,
  `ALTER TABLE developer_tickets ADD COLUMN IF NOT EXISTS desk_number     TEXT`,
  `ALTER TABLE developer_tickets ADD COLUMN IF NOT EXISTS ngo             TEXT`,
  `ALTER TABLE developer_tickets ADD COLUMN IF NOT EXISTS raised_by_panel TEXT`,
];

const TICKET_TABLES = ['support_tickets', 'ticket_replies', 'developer_tickets'];

function tableExists(name) {
  return db._pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name]
  ).then(r => r.rows.length > 0);
}

export async function ensureTicketSchema() {
  const present = {};
  for (const t of TICKET_TABLES) present[t] = await tableExists(t);

  for (const sqlText of COLUMN_STEPS) {
    const table = /ALTER TABLE (\w+)/.exec(sqlText)[1];
    if (!present[table]) continue;
    try {
      await db._pool.query(sqlText);
    } catch (e) {
      // Column may already exist under a race / parallel boot; not fatal.
      console.warn('[ticket schema] skip:', e?.message || String(e));
    }
  }
}