import db from '../config/db.js';

export const createVolunteer = async (data) => {
  const { data: result, error } = await db
    .from('bnf_volunteers')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getVolunteerById = async (id) => {
  const { data, error } = await db
    .from('bnf_volunteers')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
};

export const updateVolunteer = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('bnf_volunteers')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const listVolunteers = async ({ page = 1, pageSize = 25, search, status, ngo_id }) => {
  let query = db.from('bnf_volunteers').select('*', { count: 'exact' });
  if (search) {
    query = query.or(`full_name.ilike.%${search}%,mobile.ilike.%${search}%`);
  }
  if (status) query = query.eq('status', status);
  if (ngo_id) query = query.eq('ngo_id', ngo_id);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.order('created_at', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data || [], total: count || 0, page, pageSize };
};

export const assignToProgram = async (programId, volunteerId, role) => {
  const { data, error } = await db
    .from('program_volunteers')
    .insert({
      program_id: programId,
      volunteer_id: volunteerId,
      role: role || 'General',
      attendance_status: 'ASSIGNED',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const getProgramVolunteers = async (programId) => {
  const { data, error } = await db
    .from('program_volunteers')
    .select('*, bnf_volunteers(id, full_name, mobile, photo, skills)')
    .eq('program_id', programId);
  if (error) throw error;
  return data || [];
};

export const checkInVolunteer = async (programId, volunteerId) => {
  const { data, error } = await db
    .from('program_volunteers')
    .update({
      attendance_status: 'PRESENT',
      check_in_time: new Date().toISOString(),
    })
    .eq('program_id', programId)
    .eq('volunteer_id', volunteerId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};
