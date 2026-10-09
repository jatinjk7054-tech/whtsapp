import db from '../config/db.js';

export const addAssistance = async (beneficiaryId, data) => {
  data.beneficiary_id = beneficiaryId;
  const { data: result, error } = await db
    .from('beneficiary_assistance_requirements')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getAssistances = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_assistance_requirements')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const updateAssistance = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('beneficiary_assistance_requirements')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const removeAssistance = async (id) => {
  const { error } = await db.from('beneficiary_assistance_requirements').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Assistance record removed' };
};
