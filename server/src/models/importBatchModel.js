import db from '../config/db.js';

export const createImportBatch = async (data) => {
  const { data: result, error } = await db
    .from('import_batches')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getImportBatch = async (batchId) => {
  const { data, error } = await db
    .from('import_batches')
    .select('*')
    .eq('id', batchId)
    .single();
  if (error) return null;
  return data;
};

export const updateImportBatch = async (batchId, updates) => {
  const { data, error } = await db
    .from('import_batches')
    .update(updates)
    .eq('id', batchId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const addImportRows = async (rows) => {
  const { data, error } = await db
    .from('import_rows')
    .insert(rows)
    .select('*');
  if (error) throw error;
  return data || [];
};

export const getImportRows = async (batchId, status) => {
  let query = db.from('import_rows').select('*').eq('batch_id', batchId);
  if (status) query = query.eq('status', status);
  query = query.order('row_number');
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const updateImportRow = async (rowId, updates) => {
  const { data, error } = await db
    .from('import_rows')
    .update(updates)
    .eq('id', rowId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const listImportBatches = async ({ page = 1, pageSize = 25 }) => {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await db
    .from('import_batches')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  return { data: data || [], total: count || 0, page, pageSize };
};
