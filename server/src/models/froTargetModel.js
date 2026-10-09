import db from '../config/db.js';

export const upsertTarget = async (data) => {
  const { fro_worker_id, ngo_id, month, target_amount, set_by } = data;
  const { data: result, error } = await db
    .from('fro_monthly_targets')
    .upsert(
      { fro_worker_id, ngo_id, month, target_amount, set_by },
      { onConflict: 'fro_worker_id, ngo_id, month' }
    )
    .select()
    .single();
  if (error) throw error;
  return result;
};

// A worker can hold multiple fro_monthly_targets rows per month (one per
// ngo_id). Pick the most recently set row deterministically so the dashboard
// target query never trips the wrapper's single-row check on duplicate rows.
export const getTargetByWorker = async (workerId, month) => {
  const { data, error } = await db
    .from('fro_monthly_targets')
    .select('*')
    .eq('fro_worker_id', workerId)
    .eq('month', month)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
};

// The row a month-4+ FRO should inherit from: the most recent month strictly
// before `month`. Ordered month DESC then created_at DESC so it resolves
// duplicate (worker, month) rows the same way getTargetByWorker above does — the
// two must agree or the FRO's own strip and the NGO board will show different
// numbers for the same person.
export const getLatestTargetBeforeMonth = async (workerId, month) => {
  const { data, error } = await db
    .from('fro_monthly_targets')
    .select('*')
    .eq('fro_worker_id', workerId)
    .lt('month', month)
    .order('month', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Batch form of the above for the board/leaderboard paths, which loop over the
// whole roster and would otherwise issue one query per FRO. Returns a Map keyed
// by worker id, each value the single best prior row.
export const getLatestTargetsBeforeMonthForWorkers = async (workerIds, month) => {
  if (!workerIds || workerIds.length === 0) return new Map();
  const { data, error } = await db
    .from('fro_monthly_targets')
    .select('fro_worker_id, month, target_amount, achieved_target, created_at')
    .in('fro_worker_id', workerIds)
    .lt('month', month)
    .order('month', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;

  const best = new Map();
  for (const row of data || []) {
    const key = String(row.fro_worker_id);
    // Rows arrive already ordered, so the first one seen per worker is the
    // newest month and, within it, the newest write.
    if (!best.has(key)) best.set(key, row);
  }
  return best;
};

// The same batch lookup, but for the month actually being viewed.
//
// This board used to fetch that month per NGO via getTargetsByNgo, which drops
// any row whose ngo_id no longer matches the NGO the FRO is currently listed
// under. The table is keyed on (fro_worker_id, ngo_id, month), so a target set
// before an FRO moved between NGOs stayed invisible here and the row resolved
// as not_set - a set target that rendered as "Set target". The display contract
// is one row per FRO, so key off the worker and let the caller break the
// duplicate tie exactly as getTargetByWorker does.
export const getTargetsForWorkersMonth = async (workerIds, month) => {
  if (!workerIds || workerIds.length === 0) return new Map();
  const { data, error } = await db
    .from('fro_monthly_targets')
    .select('fro_worker_id, ngo_id, month, target_amount, achieved_target, incentive, created_at')
    .in('fro_worker_id', workerIds)
    .eq('month', month)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const best = new Map();
  for (const row of data || []) {
    const key = String(row.fro_worker_id);
    // Rows arrive newest-write-first, so the first one seen per worker is the
    // same row getTargetByWorker would return with its LIMIT 1.
    if (!best.has(key)) best.set(key, row);
  }
  return best;
};

export const getTargetsByNgo = async (ngoId, month) => {
  const { data, error } = await db
    .from('fro_monthly_targets')
    .select('*, workers!inner(id, name, login_id)')
    .eq('ngo_id', ngoId)
    .eq('month', month);
  if (error) throw error;
  return data;
};

export const updateAchievedTarget = async (workerId, ngoId, month, achievedAmount) => {
  const { data: existing } = await db
    .from('fro_monthly_targets')
    .select('id')
    .eq('fro_worker_id', workerId)
    .eq('ngo_id', ngoId)
    .eq('month', month)
    .maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from('fro_monthly_targets')
      .update({ achieved_target: achievedAmount })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from('fro_monthly_targets')
    .insert({ fro_worker_id: workerId, ngo_id: ngoId, month, achieved_target: achievedAmount, target_amount: 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateIncentive = async (workerId, ngoId, month, amount) => {
  const { data: existing } = await db
    .from('fro_monthly_targets')
    .select('id')
    .eq('fro_worker_id', workerId)
    .eq('ngo_id', ngoId)
    .eq('month', month)
    .maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from('fro_monthly_targets')
      .update({ incentive: amount })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from('fro_monthly_targets')
    .insert({ fro_worker_id: workerId, ngo_id: ngoId, month, incentive: amount, target_amount: 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getAllTargetsForNgo = async (ngoId) => {
  const { data, error } = await db
    .from('fro_monthly_targets')
    .select('*, workers!inner(id, name, login_id)')
    .eq('ngo_id', ngoId)
    .order('month', { ascending: false });
  if (error) throw error;
  return data;
};
