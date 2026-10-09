import pg from 'pg';
import db, { sql } from '../config/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v.trim());

export const createWorker = async (workerData) => {
  const { data, error } = await db
    .from('workers')
    .insert([workerData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const createWorkers = async (workersData) => {
  const { data, error } = await db
    .from('workers')
    .insert(workersData)
    .select();
  if (error) throw error;
  return data;
};

export const getAllWorkers = async (ngo_id, status) => {
  let query = db
    .from('workers')
    .select('*')
    .order('created_at', { ascending: false });

  if (ngo_id) {
    const { data: ids, error: idsErr } = await db
      .from('worker_ngo_allocations')
      .select('worker_id')
      .eq('ngo_id', ngo_id);
    if (idsErr) throw idsErr;
    const workerIds = (ids || []).map(r => r.worker_id);
    if (workerIds.length > 0) {
      query = query.in('id', workerIds);
    } else {
      query = query.eq('id', null);
    }
  }

  if (status === 'active') {
    query = query.eq('employment_status', 'active');
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getWorkerById = async (id) => {
  if (!isUuid(id)) return null;
  const { data, error } = await db
    .from('workers')
    .select('*')
    .eq('id', id)
    .order('is_active', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) {
    const missing = new Error('JSON object requested, multiple (or no) rows returned');
    missing.code = 'PGRST116';
    throw missing;
  }
  return data;
};

export const getWorkerCount = async () => {
  const { count, error } = await db
    .from('workers')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
};

export const getRecruiterWorkers = async () => {
  const { data, error } = await db
    .from('workers')
    .select('*')
    .or('department.ilike.*recruit*,department.ilike.hr*')
    .order('name', { ascending: true });
  if (error) throw error;
  return data;
};

// Next free employee_id number (e.g. existing UFS-0042 -> next 43).
export const getNextEmployeeIdNumber = async () => {
  const { rows } = await db._pool.query(`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_id, '\\D', '', 'g'), '')::int), 0) + 1 AS next
    FROM workers
    WHERE employee_id LIKE 'UFS-%'
  `);
  return rows[0].next || 1;
};

export const getWorkerByLoginId = async (login_id) => {
  const { data, error } = await db
    .from('workers')
    .select('*')
    .eq('login_id', login_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Email fallback for /auth/worker/login. Deliberately NOT .ilike(): in PostgREST
// an underscore is a single-character wildcard, and addresses like
// first_last@trust.org are common enough that it would match the wrong person.
// Exact case-insensitive comparison, newest row wins to match getWorkerByLoginId.
export const getWorkerByEmail = async (email) => {
  const target = String(email || '').trim();
  if (!target) return null;
  const rows = await sql(
    `SELECT * FROM workers
     WHERE lower(btrim(email)) = lower(btrim($1))
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [target]
  );
  return rows[0] || null;
};

// NGO admins are workers with department 'ngo admin'. When ngoId is null the
// caller wants super-admin scoped targets, so return all NGO admins.
export const getNgoAdmins = async (ngo_id) => {
  const { data, error } = await db
    .from('workers')
    .select('id, name, login_id, email, department, ngo_id')
    .ilike('department', 'ngo admin')
    .eq('employment_status', 'active')
    .eq('is_active', true)
    .order('name', { ascending: true });
  if (error) throw error;

  const admins = data || [];

  if (ngo_id == null) return admins;

  let allocatedIds = new Set();
  const { data: ids, error: idsErr } = await db
    .from('worker_ngo_allocations')
    .select('worker_id')
    .eq('ngo_id', ngo_id);
  if (idsErr) throw idsErr;
  allocatedIds = new Set((ids || []).map(r => r.worker_id));

  return admins.filter(
    (a) => a.ngo_id === ngo_id || allocatedIds.has(a.id)
  );
};

// Resolve the worker backing a token. Prefer the exact login_id row (the one
// the user logged in with) so FRO dashboards use the correct worker even if
// the workers table has duplicate id rows; fall back to id lookup.
export const getWorkerBySession = async (user) => {
  if (user && user.login_id) {
    const byLogin = await getWorkerByLoginId(user.login_id);
    if (byLogin) return byLogin;
  }
  if (user && isUuid(user.id)) return getWorkerById(user.id);
  return null;
};

export const updateWorker = async (id, updates) => {
  const { data, error } = await db
    .from('workers')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteWorker = async (id) => {
  const connStr = process.env.DATABASE_URL;
  const client = new pg.Client({
    connectionString: connStr,
    ssl: process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query('DELETE FROM attendance_corrections WHERE worker_id = $1', [id]);
    await client.query('DELETE FROM attendance WHERE worker_id = $1', [id]);
    await client.query('DELETE FROM leaves WHERE worker_id = $1', [id]);
    await client.query('DELETE FROM worker_loans WHERE worker_id = $1', [id]);
    await client.query('DELETE FROM worker_ngo_allocations WHERE worker_id = $1', [id]);
    await client.query('UPDATE conversations SET assigned_agent_id = NULL WHERE assigned_agent_id = $1', [id]);
    await client.query('DELETE FROM workers WHERE id = $1', [id]);
  } finally {
    await client.end();
  }
  return { message: 'Worker deleted successfully' };
};

export const abscondWorker = async (id) => {
  const { data, error } = await db
    .from('workers')
    .update({ employment_status: 'absconded', is_active: false })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const offboardWorker = async (id) => {
  const { data, error } = await db
    .from('workers')
    .update({ employment_status: 'offboarded', is_active: false })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};
