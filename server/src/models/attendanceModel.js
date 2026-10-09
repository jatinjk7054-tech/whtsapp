import db from '../config/db.js';

function istDateStr(date = new Date()) {
  const offset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(date.getTime() + offset);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export const getTodayAttendance = async (worker_id) => {
  const today = istDateStr();
  const { data, error } = await db
    .from('attendance')
    .select('*')
    .eq('worker_id', worker_id)
    .eq('date', today)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const createAttendance = async (record) => {
  const { data, error } = await db
    .from('attendance')
    .insert([record])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getAttendanceById = async (id) => {
  const { data, error } = await db
    .from('attendance')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const getAttendanceByWorkerDate = async (worker_id, date) => {
  const { data, error } = await db
    .from('attendance')
    .select('*')
    .eq('worker_id', worker_id)
    .eq('date', date)
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const upsertAttendanceStatus = async (worker_id, date, status, lateMinutes) => {
  const existing = await getAttendanceByWorkerDate(worker_id, date);
  const updates = { status, late_minutes: lateMinutes != null ? lateMinutes : (existing?.late_minutes || 0) };
  if (existing) {
    const { data, error } = await db
      .from('attendance')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db
    .from('attendance')
    .insert([{ worker_id, date, status, late_minutes: lateMinutes != null ? lateMinutes : 0 }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateAttendance = async (id, updates) => {
  const { data, error } = await db
    .from('attendance')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getMonthlyLateMinutes = async (worker_id) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const startIst = new Date(Date.UTC(y, m, 1));
  const endIst = new Date(Date.UTC(y, m + 1, 0));
  const startOfMonth = `${startIst.getUTCFullYear()}-${String(startIst.getUTCMonth() + 1).padStart(2, '0')}-${String(startIst.getUTCDate()).padStart(2, '0')}`;
  const endOfMonth = `${endIst.getUTCFullYear()}-${String(endIst.getUTCMonth() + 1).padStart(2, '0')}-${String(endIst.getUTCDate()).padStart(2, '0')}`;

  const { data, error } = await db
    .from('attendance')
    .select('late_minutes')
    .eq('worker_id', worker_id)
    .not('status', 'in', '(absent,leave)')
    .gte('date', startOfMonth)
    .lte('date', endOfMonth);
  if (error) throw error;

  return data.reduce((sum, row) => sum + (row.late_minutes || 0), 0);
};

export const getAttendanceHistory = async (worker_id) => {
  const { data, error } = await db
    .from('attendance')
    .select('*')
    .eq('worker_id', worker_id)
    .order('date', { ascending: false });
  if (error) throw error;
  return data;
};

export const getMonthlyAttendance = async (worker_id, startDate, endDate) => {
  const { data, error } = await db
    .from('attendance')
    .select('*')
    .eq('worker_id', worker_id)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (error) throw error;
  return data;
};

export const getAllAttendance = async () => {
  const { data, error } = await db
    .from('attendance')
    .select('*, workers(name, login_id, email, department)')
    .order('date', { ascending: false });
  if (error) throw error;
  return data;
};

export const deleteAttendance = async (id) => {
  const { data, error } = await db
    .from('attendance')
    .delete()
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getTodayAttendanceAll = async () => {
  const today = istDateStr();
  const { data, error } = await db
    .from('attendance')
    .select('*, workers(name, login_id, department)')
    .eq('date', today)
    .order('punch_in_time', { ascending: false });
  if (error) throw error;
  return data;
};

export const getFirstQRCode = async () => {
  const { data, error } = await db
    .from('qr_codes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};
