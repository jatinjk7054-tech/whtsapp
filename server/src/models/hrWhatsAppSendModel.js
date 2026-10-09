import db from '../config/db.js';

// Audit trail for every WhatsApp send from HR > Letters. Failures are stored as
// loudly as successes: a warning letter that Meta rejected (volunteer outside
// the 24h window, bad number) is exactly the case HR needs to find later.

export const createSendLog = async (row) => {
  const payload = {};
  for (const [k, v] of Object.entries(row || {})) {
    // The column list is a fixed whitelist, so an undefined/null field is simply
    // omitted and falls back to the column DEFAULT rather than writing a null
    // that the CHECK constraints would reject.
    if (v === undefined || v === null || v === '') continue;
    payload[k] = v;
  }
  const { data, error } = await db
    .from('hr_whatsapp_sends')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const listSends = async ({ worker_id, limit = 50 } = {}) => {
  let query = db
    .from('hr_whatsapp_sends')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)));

  if (worker_id) query = query.eq('worker_id', worker_id);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};
