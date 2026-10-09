import db from '../config/db.js';

export const getAllSlabs = async () => {
  const { data, error } = await db
    .from('incentive_slabs')
    .select('*')
    .order('min_amount', { ascending: true });
  if (error) throw error;
  return data || [];
};

// Stop a range's live competition for a specific date (admin action). The slab
// itself stays active/configurable; only the FRO live view excludes it.
export const stopSlabForDate = async (id, date) => {
  const { data, error } = await db
    .from('incentive_slabs')
    .update({ stopped_date: date, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Clear a stopped marker — used when the competition is restarted for a range.
export const clearSlabStop = async (id) => {
  const { data, error } = await db
    .from('incentive_slabs')
    .update({ stopped_date: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Clear stopped markers on every slab (apply-all / announce restarts everything).
export const clearAllSlabStops = async () => {
  const { data, error } = await db
    .from('incentive_slabs')
    .update({ stopped_date: null, updated_at: new Date().toISOString() })
    .eq('is_active', true)
    .select();
  if (error) throw error;
  return data || [];
};

// Ids of slabs with a live-stop marker (admin excluded / FRO hidden).
export const getStoppedSlabIds = async () => {
  const { data, error } = await db
    .from('incentive_slabs')
    .select('id, stopped_date')
    .not('stopped_date', 'is', null);
  if (error) throw error;
  return data || [];
};

export const getActiveSlabs = async () => {
  const { data, error } = await db
    .from('incentive_slabs')
    .select('*')
    .eq('is_active', true)
    .order('min_amount', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const getSlabById = async (id) => {
  const { data, error } = await db
    .from('incentive_slabs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const createSlab = async ({ min_amount, max_amount, incentive_amount, amount_to_win }) => {
  const winAt = amount_to_win ?? 1500;

  // A soft-deleted (is_active=false) row may still exist for this exact range,
  // and the unique index on (min_amount, max_amount) would reject a straight
  // insert. Reactivate it instead so admins can bring a deleted range back.
  const { data: existing } = await db
    .from('incentive_slabs')
    .select('id')
    .eq('min_amount', min_amount)
    .eq('max_amount', max_amount)
    .maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from('incentive_slabs')
      .update({
        min_amount,
        max_amount,
        incentive_amount,
        amount_to_win: winAt,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from('incentive_slabs')
    .insert([{
      min_amount,
      max_amount,
      incentive_amount,
      amount_to_win: winAt,
      is_active: true,
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateSlab = async (id, { min_amount, max_amount, incentive_amount, amount_to_win, started_at, ended_at }) => {
  const patch = {
    min_amount,
    max_amount,
    incentive_amount,
    amount_to_win: amount_to_win ?? 1500,
    updated_at: new Date().toISOString(),
  };
  if (started_at !== undefined) patch.started_at = started_at;
  if (ended_at !== undefined) patch.ended_at = ended_at;
  const { data, error } = await db
    .from('incentive_slabs')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteSlab = async (id) => {
  const { data, error } = await db
    .from('incentive_slabs')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateAllSlabs = async ({ amount_to_win, started_at, ended_at }) => {
  const patch = { updated_at: new Date().toISOString() };
  if (amount_to_win !== undefined && amount_to_win !== null) patch.amount_to_win = amount_to_win;
  if (started_at !== undefined) patch.started_at = started_at;
  if (ended_at !== undefined) patch.ended_at = ended_at;
  const { data, error } = await db
    .from('incentive_slabs')
    .update(patch)
    .eq('is_active', true)
    .select();
  if (error) throw error;
  return data || [];
};

// ─── FRO ↔ Range assignments (which FROs compete in a slab's competition) ───

export const getSlabFros = async (slabId) => {
  const { data, error } = await db
    .from('incentive_slab_fros')
    .select('fro_worker_id')
    .eq('slab_id', slabId);
  if (error) throw error;
  return (data || []).map(r => r.fro_worker_id);
};

export const getAllSlabAssignments = async () => {
  const { data, error } = await db
    .from('incentive_slab_fros')
    .select('*');
  if (error) throw error;
  return data || [];
};

export const setSlabFros = async (slabId, froIds) => {
  const ids = (froIds || []).filter(Boolean);
  const { error: delErr } = await db
    .from('incentive_slab_fros')
    .delete()
    .eq('slab_id', slabId);
  if (delErr) throw delErr;
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('incentive_slab_fros')
    .insert(ids.map(fro_worker_id => ({ slab_id: slabId, fro_worker_id })))
    .select();
  if (error) throw error;
  return (data || []).map(r => r.fro_worker_id);
};
