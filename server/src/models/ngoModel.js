import db from '../config/db.js';

export const createNgo = async ({ name, code, address, registration_no }) => {
  const { data, error } = await db
    .from('ngos')
    .insert({ name, code, address, registration_no })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getAllNgos = async () => {
  const { data, error } = await db
    .from('ngos')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getNgoById = async (id) => {
  const { data, error } = await db
    .from('ngos')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateNgo = async (id, updates) => {
  const { data, error } = await db
    .from('ngos')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const deleteNgo = async (id) => {
  const { error } = await db
    .from('ngos')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'NGO deleted successfully' };
};

export const getDailyCollectionTarget = async (ngoId) => {
  const { data, error } = await db
    .from('ngos')
    .select('daily_collection_target')
    .eq('id', ngoId)
    .single();
  if (error) return 0;
  return Number(data.daily_collection_target) || 0;
};

export const setDailyCollectionTarget = async (ngoId, target) => {
  const { data, error } = await db
    .from('ngos')
    .update({ daily_collection_target: target })
    .eq('id', ngoId)
    .select('daily_collection_target')
    .single();
  if (error) throw error;
  return Number(data.daily_collection_target) || 0;
};
