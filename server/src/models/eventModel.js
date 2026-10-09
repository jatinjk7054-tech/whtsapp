import db from '../config/db.js';

export const createEvent = async (data) => {
  const { data: result, error } = await db
    .from('events')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllEvents = async (ngo_id) => {
  let query = db
    .from('events')
    .select('*')
    .order('event_date', { ascending: true });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getUpcomingEvents = async (ngo_id, fromDate, toDate) => {
  let query = db
    .from('events')
    .select('*')
    .gte('event_date', fromDate)
    .lte('event_date', toDate)
    .eq('is_active', true)
    .order('event_date', { ascending: true });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getEventById = async (id) => {
  const { data, error } = await db
    .from('events')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateEvent = async (id, updates) => {
  const { data, error } = await db
    .from('events')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteEvent = async (id) => {
  const { error } = await db
    .from('events')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Event deleted' };
};
