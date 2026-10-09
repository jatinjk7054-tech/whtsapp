import db from '../config/db.js';

export const getAllocationsByWorker = async (workerId) => {
  const { data, error } = await db
    .from('worker_ngo_allocations')
    .select('*, ngos(name)')
    .eq('worker_id', workerId);
  if (error) throw error;
  return data || [];
};

export const setAllocations = async (workerId, allocations) => {
  const { error: delErr } = await db
    .from('worker_ngo_allocations')
    .delete()
    .eq('worker_id', workerId);
  if (delErr) throw delErr;

  if (allocations.length === 0) return [];
  const rows = allocations.map(a => ({
    worker_id: workerId,
    ngo_id: a.ngo_id,
    salary_portion: a.salary_portion,
  }));
  const { data, error } = await db
    .from('worker_ngo_allocations')
    .insert(rows)
    .select('*, ngos(name)');
  if (error) throw error;
  return data;
};

export const getWorkersByNgo = async (ngoId) => {
  const { data, error } = await db
    .from('worker_ngo_allocations')
    .select('worker_id')
    .eq('ngo_id', ngoId);
  if (error) throw error;
  return (data || []).map(r => r.worker_id);
};
