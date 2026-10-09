import db from '../config/db.js';

export const upsertEmployment = async (beneficiaryId, data) => {
  data.beneficiary_id = beneficiaryId;
  const { data: existing } = await db
    .from('beneficiary_employment')
    .select('id')
    .eq('beneficiary_id', beneficiaryId)
    .single();

  if (existing) {
    data.updated_at = new Date().toISOString();
    const { data: result, error } = await db
      .from('beneficiary_employment')
      .update(data)
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw error;
    return result;
  } else {
    const { data: result, error } = await db
      .from('beneficiary_employment')
      .insert(data)
      .select('*')
      .single();
    if (error) throw error;
    return result;
  }
};

export const getEmployment = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_employment')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};
