import db from '../config/db.js';

export const createTicket = async (data) => {
  const { data: ticket, error } = await db
    .from('attendance_corrections')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return ticket;
};

export const getTicketById = async (id) => {
  const { data, error } = await db
    .from('attendance_corrections')
    .select('*, workers(name, login_id, email), attendance(punch_in_time, punch_out_time)')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  if (data && data.attendance) {
    data.punch_in_time = data.attendance.punch_in_time;
    data.punch_out_time = data.attendance.punch_out_time;
    delete data.attendance;
  }
  return data;
};

export const getWorkerTickets = async (worker_id) => {
  const { data, error } = await db
    .from('attendance_corrections')
    .select('*, attendance(punch_in_time, punch_out_time)')
    .eq('worker_id', worker_id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (data) {
    for (const d of data) {
      if (d.attendance) { d.punch_in_time = d.attendance.punch_in_time; d.punch_out_time = d.attendance.punch_out_time; delete d.attendance; }
    }
  }
  return data;
};

export const getPendingTickets = async () => {
  const { data, error } = await db
    .from('attendance_corrections')
    .select('*, workers(name, login_id, email, department), attendance(punch_in_time, punch_out_time)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (data) {
    for (const d of data) {
      if (d.attendance) { d.punch_in_time = d.attendance.punch_in_time; d.punch_out_time = d.attendance.punch_out_time; delete d.attendance; }
    }
  }
  return data;
};

export const getHrVerifiedTickets = async () => {
  const { data, error } = await db
    .from('attendance_corrections')
    .select('*, workers(name, login_id, email, department), attendance(punch_in_time, punch_out_time)')
    .eq('status', 'hr_verified')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (data) {
    for (const d of data) {
      if (d.attendance) { d.punch_in_time = d.attendance.punch_in_time; d.punch_out_time = d.attendance.punch_out_time; delete d.attendance; }
    }
  }
  return data;
};

export const getAllTickets = async () => {
  const { data, error } = await db
    .from('attendance_corrections')
    .select('*, workers(name, login_id, email, department), attendance(punch_in_time, punch_out_time)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  if (data) {
    for (const d of data) {
      if (d.attendance) { d.punch_in_time = d.attendance.punch_in_time; d.punch_out_time = d.attendance.punch_out_time; delete d.attendance; }
    }
  }
  return data;
};

export const updateTicket = async (id, updates) => {
  const { data, error } = await db
    .from('attendance_corrections')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getPendingTicketCount = async () => {
  const { count, error } = await db
    .from('attendance_corrections')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) throw error;
  return count;
};
