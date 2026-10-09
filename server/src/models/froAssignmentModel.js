import db from '../config/db.js';

export const createAssignment = async (data) => {
  const { data: result, error } = await db
    .from('fro_assignments')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const batchCreateAssignments = async (assignments) => {
  const BATCH_SIZE = 500;
  let allData = [];
  const errors = [];
  for (let i = 0; i < assignments.length; i += BATCH_SIZE) {
    const batch = assignments.slice(i, i + BATCH_SIZE);
    const { data, error } = await db
      .from('fro_assignments')
      .insert(batch)
      .select();
    if (error) {
      console.error(`batchCreateAssignments: batch starting at index ${i} failed:`, error.message);
      errors.push({ batchIndex: i, error: error.message });
    } else if (data) {
      allData = allData.concat(data);
    }
  }
  if (errors.length > 0 && allData.length === 0) {
    throw new Error(`All batches failed: ${errors[0].error}`);
  }
  return allData;
};

export const findAssignmentById = async (id) => {
  const { data, error } = await db
    .from('fro_assignments')
    .select('*, donor_profiles!inner(*)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const findAssignmentsByWorker = async (workerId, status) => {
  let query = db
    .from('fro_assignments')
    .select('*, donor_profiles(*)')
    .eq('fro_worker_id', workerId)
    .order('assigned_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const findAssignmentsByNgo = async (ngoId, filters = {}) => {
  let query = db
    .from('fro_assignments')
    .select('*, donor_profiles(*), workers!fro_assignments_fro_worker_id_fkey(id, name, login_id)')
    .eq('ngo_id', ngoId)
    .order('assigned_at', { ascending: false });

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.worker_id) {
    query = query.eq('fro_worker_id', filters.worker_id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const updateAssignmentStatus = async (id, updates) => {
  // fro_assignments has no trigger maintaining updated_at, and the disposition
  // path only sets status/last_contacted_at, so updated_at silently lagged the
  // real edit time by days or weeks. The monthly rollover relies on an accurate
  // "last active" stamp to avoid resetting leads worked in the current month, so
  // stamp it on every status write here (the single chokepoint all callers use).
  const patch = { ...updates, updated_at: new Date().toISOString() };
  // A real disposition retires the month-boundary marker: once the FRO works the
  // lead again, "was ringing / reset on <date>" is stale and must not keep
  // showing on the row or in the CRM timeline (migration 167).
  if (updates.status && updates.status !== 'pending') {
    patch.rollover_from_status = null;
    patch.rollover_at = null;
  }
  const { data, error } = await db
    .from('fro_assignments')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getActiveAssignmentDonorIds = async (ngoId, donorIds) => {
  const ids = Array.isArray(donorIds) ? donorIds : [donorIds];
  const activeSet = new Set();
  if (!ngoId || ids.length === 0) return activeSet;
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const { data, error } = await db
      .from('fro_assignments')
      .select('donor_id')
      .eq('ngo_id', ngoId)
      .in('donor_id', chunk)
      .or('status.neq.reassigned,status.is.null');
    if (error) throw error;
    for (const a of data || []) activeSet.add(a.donor_id);
  }
  return activeSet;
};

export const getUnassignedDonorIds = async (ngoId, ngoName) => {
  let donorMobiles;

  if (ngoName) {
    const { data: mobiles, error: mErr } = await db
      .from('new_data')
      .select('mobile_number')
      .eq('ngo', ngoName)
      .not('mobile_number', 'is', null);
    if (mErr) throw mErr;
    donorMobiles = [...new Set(mobiles.map(r => r.mobile_number))];
    if (donorMobiles.length === 0) return [];
  }

  const query = db.from('donor_profiles').select('id');
  if (donorMobiles) {
    query.in('mobile_number', donorMobiles);
  }

  const { data: allDonors, error: dErr } = await query;
  if (dErr) throw dErr;

  const allIds = allDonors.map(d => d.id);
  if (allIds.length === 0) return [];

  const assignedSet = await getActiveAssignmentDonorIds(ngoId, allIds);
  return allIds.filter(id => !assignedSet.has(id));
};

export const getUnassignedDonorIdsByStation = async (ngoName, stations) => {
  const { data: allDonors, error: dErr } = await db
    .from('donor_profiles')
    .select('id')
    .eq('ngo', ngoName)
    .in('station', stations);
  if (dErr) throw dErr;
  if (!allDonors || allDonors.length === 0) return [];

  const allIds = allDonors.map(d => d.id);
  const { data: assigned, error: aErr } = await db
    .from('fro_assignments')
    .select('donor_id')
    .in('donor_id', allIds)
    .not('status', 'eq', 'reassigned');
  if (aErr) throw aErr;

  const assignedSet = new Set(assigned.map(a => a.donor_id));
  return allIds.filter(id => !assignedSet.has(id));
};

export const reassignStationDonors = async (ngoId, station, newFroWorkerId, assignedBy) => {
  // Fetch old fro_assignments for this station (donor_profiles.station may be null)
  const { data: oldRows, error: fErr } = await db
    .from('fro_assignments')
    .select('donor_id, station, batch_id, batch_type')
    .eq('ngo_id', ngoId)
    .eq('station', station)
    .not('status', 'eq', 'reassigned');
  if (fErr) throw fErr;
  if (!oldRows || oldRows.length === 0) return [];

  const donorIds = oldRows.map(r => r.donor_id);

  const oldMap = {};
  for (const a of oldRows) oldMap[a.donor_id] = a;

  // Mark old assignments as reassigned
  const { error: updErr } = await db
    .from('fro_assignments')
    .update({ status: 'reassigned', updated_at: new Date().toISOString() })
    .in('donor_id', donorIds)
    .eq('ngo_id', ngoId)
    .not('status', 'eq', 'reassigned');
  if (updErr) throw updErr;

  // Create new assignments with station, batch_id, batch_type preserved
  const newAssignments = donorIds.map(donor_id => {
    const old = oldMap[donor_id] || {};
    return {
      donor_id,
      fro_worker_id: newFroWorkerId,
      ngo_id: ngoId,
      station: old.station || station,
      batch_id: old.batch_id || null,
      batch_type: old.batch_type || null,
      assigned_by: assignedBy,
      status: 'pending',
      assigned_at: new Date().toISOString(),
    };
  });

  if (newAssignments.length > 0) {
    const { data, error } = await db
      .from('fro_assignments')
      .insert(newAssignments)
      .select();
    if (error) throw error;
    return data;
  }
  return [];
};

export const getAssignmentCountByWorker = async (ngoId) => {
  const { data, error } = await db
    .from('fro_assignments')
    .select('fro_worker_id')
    .eq('ngo_id', ngoId)
    .not('status', 'eq', 'reassigned');
  if (error) throw error;

  const counts = {};
  for (const a of data) {
    counts[a.fro_worker_id] = (counts[a.fro_worker_id] || 0) + 1;
  }
  return counts;
};

export const getDashboardStats = async (workerId) => {
  const { data, error } = await db
    .from('fro_assignments')
    .select('id, status')
    .eq('fro_worker_id', workerId);
  if (error) throw error;

  const keyMap = {
    pending: 'pending', contacted: 'contacted', follow_up: 'follow_up',
    busy: 'not_reachable', ringing: 'not_reachable', call_waiting: 'not_reachable',
    unreachable: 'not_reachable', switched_off: 'not_reachable', out_of_coverage: 'not_reachable',
    wrong_number: 'not_reachable', invalid_number: 'not_reachable', rejected: 'not_reachable',
    temporary_network_issue: 'not_reachable', voicemail: 'not_reachable',
    not_interested: 'not_interested', not_interested_now: 'not_interested',
    dnd: 'not_interested', wrong_person: 'not_interested', call_disconnected: 'contacted',
    donation_collected: 'donation_collected', lead_done: 'donation_collected',
    scheduled: 'follow_up', visit_donate: 'contacted', will_donate_online: 'contacted',
    promise_to_pay: 'contacted', payment_pending: 'contacted', already_donated: 'contacted',
    email_sent: 'contacted', whatsapp_sent: 'contacted', csr_inquiry: 'contacted',
    wants_80g_details: 'contacted', wants_trust_documents: 'contacted',
    language_barrier: 'contacted', transferred_senior: 'contacted',
    query_complaint: 'contacted', receipt_request: 'contacted',
  };
  const stats = { total: data.length, pending: 0, contacted: 0, not_reachable: 0, donation_collected: 0, not_interested: 0, follow_up: 0 };
  for (const a of data) {
    const key = keyMap[a.status];
    if (key && stats[key] !== undefined) stats[key]++;
  }
  return stats;
};

export const getDonorsByStationAndStatus = async (ngoId, station, status) => {
  let query = db
    .from('fro_assignments')
    .select('*, donor_profiles(*), workers!fro_assignments_fro_worker_id_fkey(id, name, login_id)')
    .eq('ngo_id', ngoId)
    .eq('station', station)
    .not('status', 'eq', 'reassigned');

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const getStationDispositionStats = async (ngoId, from, to) => {
  const { data, error } = await db
    .rpc('get_station_disposition_stats', {
      p_ngo_id: ngoId,
      p_from: from || null,
      p_to: to || null,
    });
  if (error) throw error;

  const stationMap = {};
  for (const row of data || []) {
    const station = row.station || 'Unassigned';
    if (!stationMap[station]) stationMap[station] = {};
    stationMap[station][row.status] = parseInt(row.count, 10);
  }
  return stationMap;
};

export const createTemporaryTransfer = async (sourceFroId, ngoIds, sourceStation, targetStation, count, autoReturnAt, assignedBy) => {
  const primaryNgoId = Array.isArray(ngoIds) ? ngoIds[0] : ngoIds;
  const { data: transfer, error: tErr } = await db
    .from('fro_transfers')
    .insert([{
      station: sourceStation, source_fro_worker_id: sourceFroId, target_fro_worker_id: null,
      target_station: targetStation, ngo_id: primaryNgoId, donor_count: count, auto_return_at: autoReturnAt, created_by: assignedBy,
    }])
    .select()
    .single();
  if (tErr) throw tErr;

  const { data: assignments } = await db
    .from('fro_assignments')
    .select('id, donor_id, status, station')
    .eq('station', sourceStation)
    .in('ngo_id', Array.isArray(ngoIds) ? ngoIds : [ngoIds])
    .not('status', 'eq', 'reassigned')
    .order('assigned_at', { ascending: true })
    .limit(count);

  if (!assignments || assignments.length === 0) {
    await db.from('fro_transfers').update({ status: 'failed', failed_reason: 'No matching assignments found' }).eq('id', transfer.id);
    return { transfer: null, transferred: 0 };
  }

  const donorIds = assignments.map(a => a.donor_id);
  await db.from('fro_transfers').update({ donor_ids: donorIds }).eq('id', transfer.id);

  const ids = assignments.map(a => a.id);
  const statuses = assignments.reduce((acc, a) => { acc[a.id] = a.status; return acc; }, {});
  const { data: updated } = await db
    .from('fro_assignments')
    .update({ status: 'reassigned', updated_at: new Date().toISOString() })
    .in('id', ids)
    .not('status', 'eq', 'reassigned')
    .select('id');
  const actuallyReassigned = new Set((updated || []).map(r => r.id));
  const newAssignments = assignments
    .filter(a => actuallyReassigned.has(a.id))
    .map(a => ({
    donor_id: a.donor_id, fro_worker_id: null, ngo_id: primaryNgoId,
    station: targetStation, status: a.status, assigned_by: assignedBy,
    assigned_at: new Date().toISOString(),
  }));

  const { error: insErr } = await db.from('fro_assignments').insert(newAssignments);
  if (insErr) throw insErr;

  transfer.donor_ids = donorIds;

  return { transfer, transferred: assignments.length };
};

export const reverseTransfer = async (transferId) => {
  const { data: transfer } = await db.from('fro_transfers').select('*').eq('id', transferId).single();
  if (!transfer || transfer.returned) return 0;

  const createdAt = transfer.created_at;
  if (!createdAt) {
    await db.from('fro_transfers').update({ returned: true, returned_at: new Date().toISOString() }).eq('id', transferId);
    return 0;
  }

  const { data: assignments } = await db
    .from('fro_assignments')
    .select('id, donor_id, status, station')
    .eq('station', transfer.target_station || transfer.station)
    .eq('ngo_id', transfer.ngo_id)
    .is('fro_worker_id', null)
    .gte('assigned_at', createdAt)
    .not('status', 'eq', 'reassigned');

  if (!assignments || assignments.length === 0) {
    await db.from('fro_transfers').update({ returned: true, returned_at: new Date().toISOString() }).eq('id', transferId);
    return 0;
  }

  const ids = assignments.map(a => a.id);
  await db.from('fro_assignments').update({ status: 'reassigned', updated_at: new Date().toISOString() }).in('id', ids);

  const { data: froAssign } = await db
    .from('fro_station_assignments')
    .select('fro_worker_id')
    .eq('station', transfer.station)
    .eq('ngo_id', transfer.ngo_id)
    .maybeSingle();

  const originalFroId = froAssign?.fro_worker_id || transfer.source_fro_worker_id;

  const newAssignments = assignments.map(a => ({
    donor_id: a.donor_id, fro_worker_id: originalFroId, ngo_id: transfer.ngo_id,
    station: transfer.station, status: a.status, assigned_by: transfer.created_by,
    assigned_at: new Date().toISOString(),
  }));

  await db.from('fro_assignments').insert(newAssignments);
  await db.from('fro_transfers').update({ returned: true, returned_at: new Date().toISOString() }).eq('id', transferId);

  return assignments.length;
};

export const createScheduledContact = async (data) => {
  const { data: result, error } = await db
    .from('fro_scheduled_contacts')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getScheduledContactsByWorker = async (workerId) => {
  const { data, error } = await db
    .from('fro_scheduled_contacts')
    .select('*, fro_assignments!inner(id, fro_worker_id)')
    .eq('fro_assignments.fro_worker_id', workerId)
    .eq('is_completed', false)
    .order('scheduled_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const getScheduledByAssignment = async (assignmentId) => {
  const { data, error } = await db
    .from('fro_scheduled_contacts')
    .select('*')
    .eq('assignment_id', assignmentId)
    .eq('is_completed', false)
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const completeScheduledContact = async (id) => {
  const { data, error } = await db
    .from('fro_scheduled_contacts')
    .update({ is_completed: true, reminded: true })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const completeAllScheduledByAssignment = async (assignmentId) => {
  const { data, error } = await db
    .from('fro_scheduled_contacts')
    .update({ is_completed: true, reminded: true })
    .eq('assignment_id', assignmentId)
    .eq('is_completed', false)
    .select();
  if (error) throw error;
  return data;
};
