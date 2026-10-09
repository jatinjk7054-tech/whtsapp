import db from '../config/db.js';

export const applyLeave = async (data) => {
  const { data: result, error } = await db
    .from('leaves')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getWorkerLeaves = async (workerId) => {
  const { data, error } = await db
    .from('leaves')
    .select('*')
    .eq('worker_id', workerId)
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getAllLeaves = async () => {
  const { data, error } = await db
    .from('leaves')
    .select('*, workers(name, login_id, email)')
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getPendingLeaves = async () => {
  const { data, error } = await db
    .from('leaves')
    .select('*, workers(name, login_id, email)')
    .eq('status', 'pending')
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const updateLeaveStatus = async (id, status, adminRemark) => {
  const { data, error } = await db
    .from('leaves')
    .update({ status, admin_remark: adminRemark, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getLeaveById = async (id) => {
  const { data, error } = await db
    .from('leaves')
    .select('*, workers(name, login_id, email)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const getApprovedLeaves = async (workerId) => {
  const { data, error } = await db
    .from('leaves')
    .select('*')
    .eq('worker_id', workerId)
    .eq('status', 'approved')
    .order('applied_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getApprovedHalfDayLeave = async (workerId, date) => {
  const { data, error } = await db
    .from('leaves')
    .select('*')
    .eq('worker_id', workerId)
    .eq('type', 'half_day')
    .eq('status', 'approved')
    .eq('leave_date', date)
    .maybeSingle();
  if (error) throw error;
  return data;
};
