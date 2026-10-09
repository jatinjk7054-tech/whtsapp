import db from '../config/db.js';

export const createAchievement = async (data) => {
  const { data: result, error } = await db
    .from('achievements')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllAchievements = async (ngo_id) => {
  let query = db
    .from('achievements')
    .select('*, workers(name, login_id)')
    .order('created_at', { ascending: false });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getRecentAchievements = async (ngo_id, since) => {
  let query = db
    .from('achievements')
    .select('*, workers(name, login_id)')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getAchievementById = async (id) => {
  const { data, error } = await db
    .from('achievements')
    .select('*, workers(name, login_id)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const deleteAchievement = async (id) => {
  const { error } = await db
    .from('achievements')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Achievement deleted' };
};
