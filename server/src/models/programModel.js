import db from '../config/db.js';

export const generateProgramCode = async () => {
  const { count } = await db.from('bnf_programs').select('id', { count: 'exact', head: true });
  return `PRG-${String((count || 0) + 1).padStart(4, '0')}`;
};

export const createProgram = async (data) => {
  const { data: result, error } = await db
    .from('bnf_programs')
    .insert(data)
    .select('*, ngos(name, code)')
    .single();
  if (error) throw error;
  return result;
};

export const getProgramById = async (id) => {
  const { data, error } = await db
    .from('bnf_programs')
    .select('*, ngos(name, code)')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateProgram = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('bnf_programs')
    .update(updates)
    .eq('id', id)
    .select('*, ngos(name, code)')
    .single();
  if (error) throw error;
  return data;
};

export const listPrograms = async ({ page = 1, pageSize = 25, status, ngo_id, from_date, to_date }) => {
  let query = db.from('bnf_programs').select('*, ngos(name, code)', { count: 'exact' });
  if (status) query = query.eq('status', status);
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  if (from_date) query = query.gte('program_date', from_date);
  if (to_date) query = query.lte('program_date', to_date);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.order('program_date', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data || [], total: count || 0, page, pageSize };
};

export const addVolunteerRequirement = async (programId, data) => {
  data.program_id = programId;
  const { data: result, error } = await db
    .from('program_volunteer_requirements')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getVolunteerRequirements = async (programId) => {
  const { data, error } = await db
    .from('program_volunteer_requirements')
    .select('*')
    .eq('program_id', programId);
  if (error) throw error;
  return data || [];
};

export const addBeneficiaryRequirement = async (programId, data) => {
  data.program_id = programId;
  const { data: result, error } = await db
    .from('program_beneficiary_requirements')
    .insert(data)
    .select('*, beneficiary_categories(id, name)')
    .single();
  if (error) throw error;
  return result;
};

export const getBeneficiaryRequirements = async (programId) => {
  const { data, error } = await db
    .from('program_beneficiary_requirements')
    .select('*, beneficiary_categories(id, name)')
    .eq('program_id', programId);
  if (error) throw error;
  return data || [];
};

export const addServiceRequirement = async (programId, data) => {
  data.program_id = programId;
  const { data: result, error } = await db
    .from('program_service_requirements')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getServiceRequirements = async (programId) => {
  const { data, error } = await db
    .from('program_service_requirements')
    .select('*')
    .eq('program_id', programId);
  if (error) throw error;
  return data || [];
};

export const addProgramRequirement = async (programId, data) => {
  data.program_id = programId;
  const { data: result, error } = await db
    .from('program_requirements')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getProgramRequirements = async (programId) => {
  const { data, error } = await db
    .from('program_requirements')
    .select('*')
    .eq('program_id', programId);
  if (error) throw error;
  return data || [];
};
