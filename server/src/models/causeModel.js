import db from '../config/db.js';

export const createCause = async ({ ngo_id, name, description, file_url, file_name }) => {
  const { data, error } = await db
    .from('causes')
    .insert({ ngo_id, name, description, file_url, file_name })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getAllCauses = async (ngo_id) => {
  let query = db
    .from('causes')
    .select('*, ngos(name, code)')
    .order('created_at', { ascending: false });

  if (ngo_id) query = query.eq('ngo_id', ngo_id);

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getCauseById = async (id) => {
  const { data, error } = await db
    .from('causes')
    .select('*, ngos(name, code)')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateCause = async (id, updates) => {
  const { data, error } = await db
    .from('causes')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const deleteCause = async (id) => {
  const { error } = await db
    .from('causes')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Cause deleted successfully' };
};
