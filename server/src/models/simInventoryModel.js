import db from '../config/db.js';

export const createInventoryItem = async (data) => {
  const { data: result, error } = await db
    .from('sim_inventory')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllInventoryItems = async () => {
  const { data, error } = await db
    .from('sim_inventory')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getInventoryItemById = async (id) => {
  const { data, error } = await db
    .from('sim_inventory')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateInventoryItem = async (id, updates) => {
  const { data, error } = await db
    .from('sim_inventory')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteInventoryItem = async (id) => {
  const { error } = await db.from('sim_inventory').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Inventory item deleted' };
};

export const bulkInsertInventoryItems = async (rows) => {
  const { data, error } = await db.from('sim_inventory').insert(rows).select();
  if (error) throw error;
  return data || [];
};
