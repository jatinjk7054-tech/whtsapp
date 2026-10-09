import db from '../config/db.js';

export const upsertEducation = async (beneficiaryId, data) => {
  data.beneficiary_id = beneficiaryId;
  // Check if record exists
  const { data: existing } = await db
    .from('beneficiary_education')
    .select('id')
    .eq('beneficiary_id', beneficiaryId)
    .single();

  if (existing) {
    data.updated_at = new Date().toISOString();
    const { data: result, error } = await db
      .from('beneficiary_education')
      .update(data)
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw error;
    return result;
  } else {
    const { data: result, error } = await db
      .from('beneficiary_education')
      .insert(data)
      .select('*')
      .single();
    if (error) throw error;
    return result;
  }
};

export const getEducation = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_education')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};
