import db from '../config/db.js';

export const createDataSource = async ({ name }) => {
  const { data, error } = await db
    .from('data_sources')
    .insert({ name })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getAllDataSources = async () => {
  const { data, error } = await db
    .from('data_sources')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getDataSourceById = async (id) => {
  const { data, error } = await db
    .from('data_sources')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateDataSource = async (id, updates) => {
  const { data, error } = await db
    .from('data_sources')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const deleteDataSource = async (id) => {
  const { error } = await db
    .from('data_sources')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Data source deleted successfully' };
};
