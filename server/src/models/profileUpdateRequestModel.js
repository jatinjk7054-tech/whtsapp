import db from '../config/db.js';

const TABLE = 'profile_update_requests';

export const createRequest = async (workerId, changes) => {
  const { data, error } = await db
    .from(TABLE)
    .insert({ worker_id: workerId, requested_changes: changes })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getWorkerRequests = async (workerId) => {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('worker_id', workerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getAllRequests = async (status) => {
  let query = db
    .from(TABLE)
    .select('*, workers!profile_update_requests_worker_id_fkey(name, login_id)')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const getRequestById = async (id) => {
  const { data, error } = await db
    .from(TABLE)
    .select('*, workers!profile_update_requests_worker_id_fkey(name, login_id)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateRequestStatus = async (id, status, reviewedBy, reviewerNotes) => {
  const { data, error } = await db
    .from(TABLE)
    .update({ status, reviewed_by: reviewedBy, reviewer_notes: reviewerNotes, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getPendingCount = async () => {
  const { count, error } = await db
    .from(TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw error;
  return count || 0;
};
