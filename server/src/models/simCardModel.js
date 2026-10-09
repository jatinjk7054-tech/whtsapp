import db from '../config/db.js';

export const createSimCard = async (data) => {
  const { data: result, error } = await db
    .from('sim_cards')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllSimCards = async () => {
  const { data, error } = await db
    .from('sim_cards')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getSimCardById = async (id) => {
  const { data, error } = await db
    .from('sim_cards')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateSimCard = async (id, updates) => {
  const { data, error } = await db
    .from('sim_cards')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteSimCard = async (id) => {
  const { error } = await db.from('sim_cards').delete().eq('id', id);
  if (error) throw error;
  return { message: 'SIM card deleted' };
};

export const createReplacement = async (data) => {
  const { data: result, error } = await db
    .from('sim_card_replacements')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllReplacements = async () => {
  const { data, error } = await db
    .from('sim_card_replacements')
    .select('*, sim_cards(mobile_id, device_model)')
    .order('replacement_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((r) => ({
    ...r,
    mobile_id: r.sim_cards?.mobile_id || null,
    device: r.device || r.sim_cards?.device_model || null,
  }));
};

export const getReplacementsBySimCard = async (simCardId) => {
  const { data, error } = await db
    .from('sim_card_replacements')
    .select('*')
    .eq('sim_card_id', simCardId)
    .order('replacement_date', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const deleteReplacementsBySimCard = async (simCardId) => {
  const { error } = await db
    .from('sim_card_replacements')
    .delete()
    .eq('sim_card_id', simCardId);
  if (error) throw error;
  return { message: 'Replacements removed' };
};

export const bulkInsertSimCards = async (rows) => {
  const { data, error } = await db.from('sim_cards').insert(rows).select();
  if (error) throw error;
  return data || [];
};

export const createSimCardHistory = async (entry) => {
  const { data, error } = await db
    .from('sim_card_history')
    .insert([entry])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getSimCardHistory = async (simCardId) => {
  const { data, error } = await db
    .from('sim_card_history')
    .select('*')
    .eq('sim_card_id', simCardId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
};

// Brand-wide number-change log. Joins the parent card so the caller gets the
// Mobile ID / device alongside each audit row, and filters on the embedded
// mobile_id instead of the client fanning out one request per card.
// Brand rules mirror the list filters in SimSection.jsx / Inventory.jsx:
//   nokia   -> mobile_id ILIKE 'ufrs%'
//   android -> 'android %' but NOT 'android whatsapp%' (companion rows are
//              hidden from every list, so they are hidden here too)
//   all     -> everything except the android whatsapp companion rows
// The LIKE patterns are written out with the SQL wildcard because this query
// builder passes filter values through verbatim (no * -> % rewriting).
export const listSimCardHistory = async ({ brand, from, limit = 5000 } = {}) => {
  let query = db
    .from('sim_card_history')
    .select('id, sim_card_id, changed_by, changed_at, changed_cols, sim_cards!inner(mobile_id, device_model)')
    .order('changed_at', { ascending: false })
    .limit(limit);

  if (brand === 'nokia') {
    query = query.ilike('sim_cards.mobile_id', 'ufrs%');
  } else if (brand === 'android') {
    query = query
      .ilike('sim_cards.mobile_id', 'android %')
      .not('sim_cards.mobile_id', 'ilike', 'android whatsapp%');
  } else {
    query = query.not('sim_cards.mobile_id', 'ilike', 'android whatsapp%');
  }

  if (from) query = query.gte('changed_at', from);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};
