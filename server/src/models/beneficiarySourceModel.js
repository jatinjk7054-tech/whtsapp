import db from '../config/db.js';

export const addSourceRecords = async (rows) => {
  if (!rows?.length) return [];
  const { data, error } = await db
    .from('beneficiary_source_records')
    .insert(rows)
    .select('*');
  if (error) throw error;
  return data || [];
};

export const addSourceRecord = async (beneficiaryId, data) => {
  data.beneficiary_id = beneficiaryId;
  const { data: result, error } = await db
    .from('beneficiary_source_records')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getSourceRecords = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_source_records')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const findByOriginalData = async (fields) => {
  // Search for possible duplicates based on name, mobile, dob
  let query = db.from('beneficiaries').select('id, beneficiary_code, full_name, mobile, date_of_birth, status');
  const conditions = [];
  if (fields.mobile) conditions.push(`mobile.eq.${fields.mobile}`);
  if (fields.full_name) conditions.push(`full_name.ilike.%${fields.full_name}%`);
  if (fields.date_of_birth) conditions.push(`date_of_birth.eq.${fields.date_of_birth}`);

  if (conditions.length === 0) return [];
  query = query.or(conditions.join(',')).limit(10);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};
