import db from '../config/db.js';

export const createCategory = async (data) => {
  const { data: result, error } = await db
    .from('beneficiary_categories')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getAllCategories = async () => {
  const { data, error } = await db
    .from('beneficiary_categories')
    .select('*')
    .order('name');
  if (error) throw error;
  return data || [];
};

export const updateCategory = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('beneficiary_categories')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const assignCategories = async (beneficiaryId, categoryIds) => {
  // Remove existing
  await db.from('beneficiary_category_assignments').delete().eq('beneficiary_id', beneficiaryId);
  if (!categoryIds || categoryIds.length === 0) return [];

  const rows = categoryIds.map(category_id => ({
    beneficiary_id: beneficiaryId,
    category_id,
  }));

  const { data, error } = await db
    .from('beneficiary_category_assignments')
    .insert(rows)
    .select('*');
  if (error) throw error;
  return data || [];
};

export const getBeneficiaryCategories = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_category_assignments')
    .select('category_id, beneficiary_categories(id, name, description)')
    .eq('beneficiary_id', beneficiaryId);
  if (error) throw error;
  return (data || []).map(r => r.beneficiary_categories).filter(Boolean);
};
