import db from '../config/db.js';

export const createStationAssignment = async (data) => {
  const { data: result, error } = await db
    .from('fro_station_assignments')
    .insert([data])
    .select('*, workers!fro_station_assignments_fro_worker_id_fkey(id, name, login_id)')
    .single();
  if (error) throw error;
  return result;
};

export const upsertStationAssignment = async (fro_worker_id, ngo_id, station, assigned_by) => {
  const { data: existing } = await db
    .from('fro_station_assignments')
    .select('id')
    .eq('ngo_id', ngo_id)
    .eq('station', station)
    .maybeSingle();

  if (existing) {
    const payload = { updated_at: new Date().toISOString() };
    if (fro_worker_id !== undefined) payload.fro_worker_id = fro_worker_id;
    const { data, error } = await db
      .from('fro_station_assignments')
      .update(payload)
      .eq('id', existing.id)
      .select('*, workers!fro_station_assignments_fro_worker_id_fkey(id, name, login_id)')
      .single();
    if (error) throw error;
    return data;
  }

  const insertData = { ngo_id, station, assigned_by };
  if (fro_worker_id) insertData.fro_worker_id = fro_worker_id;

  const { data, error } = await db
    .from('fro_station_assignments')
    .insert([insertData])
    .select('*, workers!fro_station_assignments_fro_worker_id_fkey(id, name, login_id)')
    .single();
  if (error) throw error;
  return data;
};

export const createStation = async (ngo_id, station, assigned_by) => {
  const { data: existing } = await db
    .from('fro_station_assignments')
    .select('id')
    .eq('ngo_id', ngo_id)
    .eq('station', station)
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await db
    .from('fro_station_assignments')
    .insert([{ ngo_id, station, assigned_by }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getStationAssignmentsByNgo = async (ngoIds, includeNull = false) => {
  let query = db
    .from('fro_station_assignments')
    .select('*, workers!fro_station_assignments_fro_worker_id_fkey(id, name, login_id, is_test)');

  if (includeNull && ngoIds.length > 0) {
    query = query.or(`ngo_id.in.(${ngoIds.join(',')}),ngo_id.is.null`);
  } else if (ngoIds.length > 0) {
    query = query.in('ngo_id', ngoIds);
  } else {
    return [];
  }

  const { data, error } = await query.order('station', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const deleteStationAssignment = async (id) => {
  const { error } = await db
    .from('fro_station_assignments')
    .delete()
    .eq('id', id);
  if (error) throw error;
};

export const ensureStationsExist = async (ngoId, stationNames, assignedBy) => {
  if (!stationNames || stationNames.length === 0) return [];
  const { data: existing } = await db
    .from('fro_station_assignments')
    .select('station')
    .eq('ngo_id', ngoId)
    .in('station', stationNames);
  const existingSet = new Set((existing || []).map(s => s.station));
  const missing = stationNames.filter(s => !existingSet.has(s));
  if (missing.length === 0) return [];

  const rows = missing.map(station => ({
    ngo_id: ngoId,
    station,
    assigned_by: assignedBy || null,
  }));
  const { data, error } = await db
    .from('fro_station_assignments')
    .insert(rows)
    .select();
  if (error) throw error;
  return data || [];
};

export const getStationAssignmentByNgoAndStation = async (ngoId, station) => {
  const { data, error } = await db
    .from('fro_station_assignments')
    .select('*, workers!fro_station_assignments_fro_worker_id_fkey(id, name, login_id)')
    .eq('ngo_id', ngoId)
    .eq('station', station)
    .maybeSingle();
  if (error) throw error;
  return data;
};
