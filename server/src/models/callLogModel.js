import db from '../config/db.js';

export const createCallLog = async (data) => {
  const { data: log, error } = await db
    .from('call_logs')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return log;
};

export const getCallLogsByTelecaller = async (telecallerId, filters = {}) => {
  let query = db
    .from('call_logs')
    .select('*, leads(name, phone)')
    .eq('telecaller_id', telecallerId)
    .order('call_time', { ascending: false });

  if (filters.lead_id) query = query.eq('lead_id', filters.lead_id);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.call_type) query = query.eq('call_type', filters.call_type);
  if (filters.from_date) query = query.gte('call_time', filters.from_date);
  if (filters.to_date) query = query.lte('call_time', filters.to_date + 'T23:59:59Z');

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getCallLogsByLead = async (leadId) => {
  const { data, error } = await db
    .from('call_logs')
    .select('*')
    .eq('lead_id', leadId)
    .order('call_time', { ascending: false });
  if (error) throw error;
  return data;
};

export const getCallLogById = async (id) => {
  const { data, error } = await db
    .from('call_logs')
    .select('*, leads(name, phone)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const getTodayCallCount = async (telecallerId) => {
  const today = new Date().toISOString().slice(0, 10);
  const { count, error } = await db
    .from('call_logs')
    .select('*', { count: 'exact', head: true })
    .eq('telecaller_id', telecallerId)
    .gte('call_time', today);
  if (error) throw error;
  return count;
};

export const getFollowUpsDue = async (telecallerId) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('call_logs')
    .select('id')
    .eq('telecaller_id', telecallerId)
    .lte('follow_up_date', today)
    .not('follow_up_date', 'is', null);
  if (error) throw error;

  const unique = new Set(data.map(d => d.id));
  return unique.size;
};
