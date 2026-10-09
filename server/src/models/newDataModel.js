import db from '../config/db.js';

export const insertNewDataBatch = async (rows) => {
  const { data, error } = await db
    .from('new_data')
    .insert(rows)
    .select();
  if (error) throw error;
  return data;
};

export const getImportBatches = async () => {
  const { data, error } = await db
    .from('new_data')
    .select('import_batch_id, data_source_id, import_date, created_at, data_sources(name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  const seen = {};
  const batches = [];
  for (const row of data) {
    if (!seen[row.import_batch_id]) {
      seen[row.import_batch_id] = true;
      batches.push({
        import_batch_id: row.import_batch_id,
        data_source_id: row.data_source_id,
        data_source_name: row.data_sources?.name || 'Unknown',
        import_date: row.import_date,
        created_at: row.created_at,
      });
    }
  }
  return batches;
};

export const getBatchRecords = async (batchId, { limit = null, offset = 0 } = {}) => {
  const query = db
    .from('new_data')
    .select('*')
    .eq('import_batch_id', batchId)
    .order('created_at', { ascending: true });
  if (limit) query.range(offset, offset + limit - 1);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getBatchCount = async (batchId) => {
  const { count, error } = await db
    .from('new_data')
    .select('*', { count: 'exact', head: true })
    .eq('import_batch_id', batchId);
  if (error) throw error;
  return count || 0;
};

export const updateNewDataStatus = async (mobiles, ngoName, status) => {
  if (!ngoName) throw new Error('ngoName is required for updateNewDataStatus');
  const query = db
    .from('new_data')
    .update({ status })
    .in('mobile_number', mobiles)
    .eq('ngo', ngoName);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const updateNewDataStatusByNgoAndMobiles = async (ngoName, mobiles, status) => {
  const { data, error } = await db
    .from('new_data')
    .update({ status })
    .eq('ngo', ngoName)
    .in('mobile_number', mobiles);
  if (error) throw error;
  return data;
};

export const getExistingMobilesForNgo = async (mobiles, ngoName) => {
  const existing = new Set();
  if (!mobiles || mobiles.length === 0 || !ngoName) return existing;
  const BATCH = 1000;

  // 1) Already imported for this NGO
  for (let i = 0; i < mobiles.length; i += BATCH) {
    const chunk = mobiles.slice(i, i + BATCH);
    const { data, error } = await db
      .from('new_data')
      .select('mobile_number')
      .in('mobile_number', chunk)
      .eq('ngo', ngoName);
    if (error) throw error;
    for (const r of data || []) existing.add(r.mobile_number);
  }

  // 2) Already has an assignment in this NGO (old-data OD or earlier fresh FD)
  const { data: ngoRows } = await db.from('ngos').select('id').eq('name', ngoName).limit(1);
  const ngoRow = ngoRows && ngoRows.length > 0 ? ngoRows[0] : null;
  if (ngoRow && ngoRow.id) {
    const ngoId = ngoRow.id;
    const donorIdToMobile = new Map();
    for (let i = 0; i < mobiles.length; i += BATCH) {
      const chunk = mobiles.slice(i, i + BATCH);
      const { data: profiles } = await db
        .from('donor_profiles')
        .select('id, mobile_number')
        .in('mobile_number', chunk);
      if (profiles) {
        for (const p of profiles) {
          if (p.id) donorIdToMobile.set(p.id, p.mobile_number);
        }
      }
    }
    const donorIds = [...donorIdToMobile.keys()];
    for (let i = 0; i < donorIds.length; i += BATCH) {
      const idChunk = donorIds.slice(i, i + BATCH);
      const { data: asgn, error } = await db
        .from('fro_assignments')
        .select('donor_id')
        .in('donor_id', idChunk)
        .eq('ngo_id', ngoId)
        .not('status', 'eq', 'reassigned');
      if (error) throw error;
      for (const a of asgn || []) {
        const m = donorIdToMobile.get(a.donor_id);
        if (m) existing.add(m);
      }
    }
  }

  return existing;
};

export const getBatchById = async (batchId) => {
  const { data, error } = await db
    .from('new_data')
    .select('import_batch_id, data_source_id, import_date, created_at, data_sources(name)')
    .eq('import_batch_id', batchId)
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return {
    import_batch_id: data[0].import_batch_id,
    data_source_id: data[0].data_source_id,
    data_source_name: data[0].data_sources?.name || 'Unknown',
    import_date: data[0].import_date,
    created_at: data[0].created_at,
  };
};
