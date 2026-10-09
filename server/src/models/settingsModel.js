import db from '../config/db.js';

export const getSetting = async (key) => {
  const { data, error } = await db
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data?.value ?? null;
};

export const getAllSettings = async () => {
  const { data, error } = await db
    .from('settings')
    .select('*')
    .order('key');
  if (error) throw error;
  const map = {};
  for (const row of data) map[row.key] = row.value;
  return map;
};

export const upsertSetting = async (key, value) => {
  const { data, error } = await db
    .from('settings')
    .upsert({ key, value })
    .select()
    .single();
  if (error) throw error;
  return data;
};
