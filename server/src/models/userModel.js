import db from '../config/db.js';

export const createUser = async ({ ngo_id, name, email, password_hash, role, department, created_by }) => {
  const { data, error } = await db
    .from('users')
    .insert({ ngo_id, name, email, password_hash, role, department, created_by })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getUserByName = async (name) => {
  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('name', name)
    .single();
  if (error) return null;
  return data;
};

export const getUserByEmail = async (email) => {
  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('email', email)
    .single();
  if (error) return null;
  return data;
};

export const getUserById = async (id) => {
  const { data, error } = await db
    .from('users')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const getAllUsers = async (filters = {}) => {
  let query = db
    .from('users')
    .select('*')
    .order('created_at', { ascending: false });

  if (filters.ngo_id) query = query.eq('ngo_id', filters.ngo_id);
  if (filters.role) query = query.eq('role', filters.role);
  if (filters.is_active !== undefined) query = query.eq('is_active', filters.is_active);

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const updateUser = async (id, updates) => {
  const { data, error } = await db
    .from('users')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getUsersCountByRole = async (ngo_id) => {
  let query = db
    .from('users')
    .select('role, count', { count: 'exact', head: false });

  if (ngo_id) query = query.eq('ngo_id', ngo_id);

  const { data, error } = await query;
  if (error) throw error;

  const counts = { hoadmin: 0, hr: 0, accounts: 0, leads: 0, recruiter: 0, telecaller: 0, team_lead: 0 };
  data.forEach((row) => {
    if (counts[row.role] !== undefined) counts[row.role] = row.count;
  });
  return counts;
};
