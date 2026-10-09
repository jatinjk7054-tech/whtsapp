import db from '../config/db.js';

export const getTargetsByWorker = async (workerId) => {
  const { data, error } = await db
    .from('incentive_targets')
    .select('*')
    .eq('worker_id', workerId)
    .order('month', { ascending: false });
  if (error) throw error;
  return data;
};

export const getTarget = async (workerId, month) => {
  const { data, error } = await db
    .from('incentive_targets')
    .select('*')
    .eq('worker_id', workerId)
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;

  if (data && !data.is_auto_generated) return data;

  const { data: froData, error: froError } = await db
    .from('fro_monthly_targets')
    .select('*')
    .eq('fro_worker_id', workerId)
    .eq('month', month)
    .maybeSingle();
  if (froError) throw froError;
  if (froData) {
    return {
      worker_id: froData.fro_worker_id,
      month: froData.month,
      target_amount: froData.target_amount,
      is_auto_generated: false,
    };
  }

  if (data) return data;

  return null;
};

export const upsertTarget = async (data) => {
  const { data: existing } = await db
    .from('incentive_targets')
    .select('id')
    .eq('worker_id', data.worker_id)
    .eq('month', data.month)
    .maybeSingle();

  if (existing) {
    const { data: result, error } = await db
      .from('incentive_targets')
      .update(data)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return result;
  }

  const { data: result, error } = await db
    .from('incentive_targets')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getCurrentMonthTargets = async () => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const monthStart = `${y}-${m}-01`;

  const { data, error } = await db
    .from('incentive_targets')
    .select('*, workers(name, email, department, salary_history!inner(salary))')
    .eq('month', monthStart)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getFROWorkersWithSalary = async () => {
  const { data, error } = await db
    .from('workers')
    .select('id, name, department, created_at, salary_history(salary, from_month, to_month)')
    .eq('department', 'FRO')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data.map(w => ({
    ...w,
    active_salary: Array.isArray(w.salary_history)
      ? w.salary_history
          .filter(s => !s.to_month || s.to_month >= new Date().toISOString().slice(0, 10))
          .sort((a, b) => new Date(b.from_month) - new Date(a.from_month))[0]
      : null,
  }));
};
