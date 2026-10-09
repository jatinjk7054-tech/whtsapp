import db from '../config/db.js';

export const getUserSetting = async (userId, key) => {
  const { data, error } = await db
    .from('user_settings')
    .select('value')
    .eq('user_id', userId)
    .eq('key', key)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data?.value ?? null;
};

export const getAllUserSettings = async (userId) => {
  const { data, error } = await db
    .from('user_settings')
    .select('key, value')
    .eq('user_id', userId);
  if (error) throw error;
  const map = {};
  for (const row of data) map[row.key] = row.value;
  return map;
};

export const upsertUserSetting = async (userId, key, value) => {
  const { data, error } = await db
    .from('user_settings')
    .upsert({ user_id: userId, key, value }, { onConflict: 'user_id,key' })
    .select()
    .single();
  if (error) throw error;
  return data;
};
