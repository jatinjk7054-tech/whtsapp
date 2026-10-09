import db from '../config/db.js';

export const getAchievements = async (workerId, startDate, endDate) => {
  const { data, error } = await db
    .from('daily_achievements')
    .select('*')
    .eq('worker_id', workerId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (error) throw error;
  return data;
};

export const getAchievement = async (workerId, date) => {
  const { data, error } = await db
    .from('daily_achievements')
    .select('*')
    .eq('worker_id', workerId)
    .eq('date', date)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const upsertAchievement = async (workerId, date, amount, userId) => {
  const { data: existing } = await db
    .from('daily_achievements')
    .select('id')
    .eq('worker_id', workerId)
    .eq('date', date)
    .maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from('daily_achievements')
      .update({ amount, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from('daily_achievements')
    .insert([{ worker_id: workerId, date, amount, created_by: userId }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteAchievement = async (id) => {
  const { error } = await db
    .from('daily_achievements')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Achievement deleted' };
};

export const getMonthlyAchievementTotal = async (workerId, startDate, endDate) => {
  const { data, error } = await db
    .from('daily_achievements')
    .select('amount')
    .eq('worker_id', workerId)
    .gte('date', startDate)
    .lte('date', endDate);
  if (error) throw error;
  return data.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
};

export const bulkUpsertAchievements = async (entries) => {
  const results = [];
  for (const entry of entries) {
    const { worker_id, date, amount, created_by } = entry;
    const result = await upsertAchievement(worker_id, date, amount, created_by);
    results.push(result);
  }
  return results;
};

export const getAllFRODailyAchievements = async (startDate, endDate) => {
  const { data, error } = await db
    .from('daily_achievements')
    .select('*, workers!inner(id, name, department)')
    .eq('workers.department', 'FRO')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (error) throw error;
  return data;
};
