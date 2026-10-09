import { getWorkersByNgo } from '../models/workerNgoAllocationModel.js';
import { getStationAssignmentsByNgo, ensureStationsExist } from '../models/froStationAssignmentModel.js';
import { getActiveAssignmentDonorIds, batchCreateAssignments } from '../models/froAssignmentModel.js';
import { updateNewDataStatusByNgoAndMobiles } from '../models/newDataModel.js';

export async function autoAssignDonorsToStations(rows, importBatchId, ngos) {
  let totalAssigned = 0;
  const breakdown = {};

  for (const ngo of ngos) {
    const ngoId = typeof ngo === 'object' ? ngo.id : ngo;
    const ngoName = typeof ngo === 'object' ? ngo.name : String(ngo);

    const stationAssigns = await getStationAssignmentsByNgo([ngoId]);
    if (stationAssigns.length === 0) continue;

    const stationFroMap = {};
    for (const sa of stationAssigns) {
      stationFroMap[sa.station] = sa.fro_worker_id;
    }
    const stationNames = stationAssigns.map(sa => sa.station);

    const { data: mobiles } = await db
      .from('new_data')
      .select('mobile_number, station, agent_name')
      .eq('import_batch_id', importBatchId)
      .eq('ngo', ngoName)
      .not('mobile_number', 'is', null);

    if (!mobiles || mobiles.length === 0) continue;

    const uniqueMobiles = [...new Set(mobiles.map(m => m.mobile_number))];

    const { data: profiles } = await db
      .from('donor_profiles')
      .select('id, mobile_number')
      .in('mobile_number', uniqueMobiles);

    if (!profiles || profiles.length === 0) continue;
    const profileIds = profiles.map(p => p.id);

    const assignedSet = await getActiveAssignmentDonorIds(ngoId, profileIds);
    const unassignedProfiles = profiles.filter(p => !assignedSet.has(p.id));
    if (unassignedProfiles.length === 0) continue;

    // Build FRO name → station map (from workers table)
    const froNameToStation = {};
    const missingWorkerIds = stationAssigns
      .filter(sa => sa.fro_worker_id && !sa.workers)
      .map(sa => sa.fro_worker_id);
    const workerNameMap = {};
    if (missingWorkerIds.length > 0) {
      const { data: workers } = await db
        .from('workers')
        .select('id, name')
        .in('id', missingWorkerIds);
      if (workers) {
        for (const w of workers) {
          workerNameMap[w.id] = w.name || '';
        }
      }
    }
    for (const sa of stationAssigns) {
      if (!sa.fro_worker_id) continue;
      const workerName = sa.workers?.name || workerNameMap[sa.fro_worker_id] || '';
      if (workerName) {
        froNameToStation[workerName.toLowerCase().trim()] = sa.station;
      }
    }

    const mobileDataMap = {};
    for (const m of mobiles) {
      mobileDataMap[m.mobile_number] = m;
    }

    const newAssignments = [];
    const stationCounts = {};
    for (const s of stationNames) stationCounts[s] = 0;

    for (const profile of unassignedProfiles) {
      const rowData = mobileDataMap[profile.mobile_number] || {};
      let station = null;

      // Priority 1: Station column in Excel
      if (rowData.station && stationNames.includes(rowData.station)) {
        station = rowData.station;
      }

      // Priority 2: FRO name column in Excel (stored in agent_name)
      if (!station && rowData.agent_name) {
        const key = rowData.agent_name.toLowerCase().trim();
        const matchKey = Object.keys(froNameToStation).find(k =>
          k === key || k.includes(key) || key.includes(k)
        );
        if (matchKey) {
          station = froNameToStation[matchKey];
        }
      }

      if (station) {
        newAssignments.push({
          donor_id: profile.id,
          fro_worker_id: stationFroMap[station] || null,
          ngo_id: ngoId,
          station,
          status: 'pending',
          assigned_at: new Date().toISOString(),
        });
        stationCounts[station] = (stationCounts[station] || 0) + 1;
      }
    }

    if (newAssignments.length > 0) {
      await batchCreateAssignments(newAssignments);
      totalAssigned += newAssignments.length;

      const matchedMobiles = new Set();
      const profileIdToMobile = {};
      for (const p of profiles) profileIdToMobile[p.id] = p.mobile_number;
      for (const a of newAssignments) {
        const mobile = profileIdToMobile[a.donor_id];
        if (mobile) matchedMobiles.add(mobile);
      }
      await updateNewDataStatusByNgoAndMobiles(ngoName, [...matchedMobiles], 'converted');
    }

    breakdown[ngoName] = {};
    for (const [st, cnt] of Object.entries(stationCounts)) {
      if (cnt > 0) breakdown[ngoName][st] = cnt;
    }
  }

  return { totalAssigned, breakdown };
}

export async function roundRobinAssignToStations(ngoName, ngoId, pickedStations, importBatchId, assignedBy) {
  if (!pickedStations || pickedStations.length === 0) return { assigned: 0, stationBreakdown: {} };

  await ensureStationsExist(ngoId, pickedStations, assignedBy);

  const stationAssigns = await getStationAssignmentsByNgo([ngoId]);
  const stationFroMap = {};
  for (const sa of stationAssigns) {
    if (pickedStations.includes(sa.station)) {
      stationFroMap[sa.station] = sa.fro_worker_id;
    }
  }

  const { data: mobiles } = await db
    .from('new_data')
    .select('mobile_number')
    .eq('import_batch_id', importBatchId)
    .eq('ngo', ngoName)
    .not('mobile_number', 'is', null);

  if (!mobiles || mobiles.length === 0) return { assigned: 0, stationBreakdown: {} };

  const uniqueMobiles = [...new Set(mobiles.map(m => m.mobile_number))];

  const { data: profiles } = await db
    .from('donor_profiles')
    .select('id, mobile_number')
    .in('mobile_number', uniqueMobiles);

  if (!profiles || profiles.length === 0) return { assigned: 0, stationBreakdown: {} };

  const profileIds = profiles.map(p => p.id);
  const assignedSet = await getActiveAssignmentDonorIds(ngoId, profileIds);
  const unassignedProfiles = profiles.filter(p => !assignedSet.has(p.id));
  if (unassignedProfiles.length === 0) return { assigned: 0, stationBreakdown: {} };

  const newAssignments = [];
  const stationCounts = {};
  for (const s of pickedStations) stationCounts[s] = 0;

  for (let i = 0; i < unassignedProfiles.length; i++) {
    const station = pickedStations[i % pickedStations.length];
    newAssignments.push({
      donor_id: unassignedProfiles[i].id,
      fro_worker_id: stationFroMap[station] || null,
      ngo_id: ngoId,
      station,
      batch_id: importBatchId,
      batch_type: 'new_data',
      status: 'pending',
      is_new: true,
      assigned_at: new Date().toISOString(),
    });
    stationCounts[station] = (stationCounts[station] || 0) + 1;
  }

  if (newAssignments.length > 0) {
    await batchCreateAssignments(newAssignments);
    const matchedMobiles = new Set();
    const profileIdToMobile = {};
    for (const p of profiles) profileIdToMobile[p.id] = p.mobile_number;
    for (const a of newAssignments) {
      const mobile = profileIdToMobile[a.donor_id];
      if (mobile) matchedMobiles.add(mobile);
    }
    await updateNewDataStatusByNgoAndMobiles(ngoName, [...matchedMobiles], 'converted');
  }

  const stationBreakdown = {};
  for (const [st, cnt] of Object.entries(stationCounts)) {
    if (cnt > 0) stationBreakdown[st] = cnt;
  }

  return { assigned: newAssignments.length, stationBreakdown };
}
