import { query } from '../db/pool.js';

/**
 * Keeps only digits so every stored address matches the E.164 wa_id used by the
 * WhatsApp webhook. A `+` or spaces in the user's input never create a duplicate.
 */
export function normalizeWaId(mobile) {
  return String(mobile ?? '').replace(/\D/g, '');
}

/**
 * Inserts a brand-new contact. Duplicates are rejected by the UNIQUE index on
 * wa_id (callers map 23505 to "Contact already exists"); notes/tags are
 * internal-only CRM fields and are never part of any WhatsApp payload.
 */
export async function createContact(waId, { name = '', notes = '', tags = [] } = {}) {
  const result = await query(
    `INSERT INTO contacts (wa_id, name, notes, tags)
     VALUES ($1, $2, $3, $4::text[])
     RETURNING id, wa_id, name, notes, tags, created_at, updated_at`,
    [waId, name, notes, tags]
  );
  return result.rows[0] ?? null;
}

export async function getContactByWaId(waId) {
  const result = await query(
    `SELECT id, wa_id, name, notes, tags, created_at, updated_at FROM contacts WHERE wa_id = $1`,
    [waId]
  );
  return result.rows[0] ?? null;
}

/**
 * One query for the Customer Profile panel: the contact, its most relevant
 * conversation (a live one first, else the most recently touched), the assigned
 * agent, the latest message and the contact's tags (Module 5 — joined from
 * contact_tags so a rename or colour change shows up everywhere at once).
 * Access checks happen in the route, exactly like getThread — the data is only
 * ever returned to the owner or an admin.
 */
export async function getContactProfile(waId) {
  const result = await query(
    `SELECT ct.id AS contact_id, ct.wa_id, ct.name, ct.notes, ct.tags,
            ct.created_at AS first_contact_at,
            cv.id AS conversation_id, cv.status AS conversation_status,
            cv.assigned_staff_id, cv.last_message_at,
            s.name AS assigned_staff_name,
            tg.list AS tag_list,
            lm.body AS last_message_body,
            lm.direction AS last_message_direction,
            lm.created_at AS last_message_at_exact
       FROM contacts ct
       LEFT JOIN LATERAL (
         SELECT c.* FROM conversations c
          WHERE c.contact_id = ct.id
          ORDER BY (c.status <> 'closed') ASC, c.updated_at DESC
          LIMIT 1
       ) cv ON TRUE
       LEFT JOIN staff s ON s.id = cv.assigned_staff_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(
                  json_agg(
                    json_build_object('id', t.id, 'name', t.name, 'color', t.color)
                    ORDER BY t.id
                  ),
                  '[]'::json
                ) AS list
           FROM contact_tags ctg
           JOIN tags t ON t.id = ctg.tag_id
          WHERE ctg.contact_id = ct.id
       ) tg ON TRUE
       LEFT JOIN LATERAL (
         SELECT m.body, m.direction, m.created_at FROM messages m
          WHERE m.conversation_id = cv.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
       ) lm ON TRUE
      WHERE ct.wa_id = $1`,
    [waId]
  );
  return result.rows[0] ?? null;
}