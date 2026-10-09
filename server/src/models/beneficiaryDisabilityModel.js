import db from '../config/db.js';

export const addDisabilities = async (rows) => {
  if (!rows?.length) return [];
  const { data, error } = await db
    .from('beneficiary_disabilities')
    .insert(rows)
    .select('*');
  if (error) throw error;
  return data || [];
};

// Which of these members already have a disability recorded, in one query —
// the importer uses it to avoid adding a second row for the same person.
export const beneficiaryIdsWithDisabilities = async (ids) => {
  const wanted = [...new Set((ids || []).filter((v) => v != null))];
  if (wanted.length === 0) return new Set();

  const withDisability = new Set();
  const CHUNK = 100;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const slice = wanted.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('beneficiary_disabilities')
      .select('beneficiary_id')
      .in('beneficiary_id', slice);
    if (error) throw error;
    for (const d of data || []) withDisability.add(d.beneficiary_id);
  }
  return withDisability;
};

export const addDisability = async (beneficiaryId, data) => {
  data.beneficiary_id = beneficiaryId;
  const { data: result, error } = await db
    .from('beneficiary_disabilities')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getDisabilities = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_disabilities')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const updateDisability = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('beneficiary_disabilities')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const removeDisability = async (id) => {
  const { error } = await db.from('beneficiary_disabilities').delete().eq('id', id);
  if (error) throw error;
  return { message: 'Disability record removed' };
};
