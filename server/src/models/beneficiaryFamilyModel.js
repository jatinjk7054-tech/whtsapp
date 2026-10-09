import db from '../config/db.js';

export const addFamilyMember = async (beneficiaryId, data) => {
  data.beneficiary_id = beneficiaryId;
  const { data: result, error } = await db
    .from('beneficiary_family_members')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getFamilyMembers = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_family_members')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('created_at');
  if (error) throw error;
  return data || [];
};

export const updateFamilyMember = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('beneficiary_family_members')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const removeFamilyMember = async (id) => {
  const { error } = await db.from('beneficiary_family_members').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Family member removed' };
};
