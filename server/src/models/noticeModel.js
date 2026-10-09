import db from '../config/db.js';

const VALID_ROLES = ['all', 'super_admin', 'admin', 'hr', 'accounts', 'recruiter', 'leads', 'telecaller', 'team_lead', 'worker', 'fro', 'ngo', 'event_head'];

function sanitizeRole(role) {
  return VALID_ROLES.includes(role) ? role : null;
}

const LEGACY_ALL_ROLES = new Set(['all', 'null']);

// Department strings that a logged-in worker may hold (authController maps them
// to a panel role). A worker whose department falls through to the generic
// 'worker' role still belongs to one of these panels, so a notice targeted to
// that panel must reach them too.
const DEPT_PANELS = [
  [/^fro/, 'fro'],
  [/^hr/, 'hr'],
  [/recruit/, 'recruiter'],
  [/^accounts?/, 'accounts'],
  [/^admin$/, 'accounts'],
  [/^ngo[-_ ]?admin/, 'admin'],
  [/event/, 'event_head'],
  [/digital|develop/, 'digital'],
];

function deptPanel(dept) {
  const d = String(dept || '').trim().toLowerCase();
  for (const [re, panel] of DEPT_PANELS) {
    if (re.test(d)) return panel;
  }
  return null;
}

// target_roles takes precedence over the legacy single target_role column.
// Specific list → role (or the user's department panel) must be in it; contains
// 'all' or missing target_roles → everyone (legacy fallback). The `panel` arg is
// the panel the client is actually viewing (e.g. ?target_role=fro) so real panel
// users receive their panel's notices even when their stored role/dept is generic.
function noticeMatchesRole(n, role, dept, panel) {
  const raw = Array.isArray(n.target_roles) && n.target_roles.length
    ? n.target_roles
    : (n.target_role && !LEGACY_ALL_ROLES.has(String(n.target_role).toLowerCase()) ? [n.target_role] : ['all']);
  if (raw.includes('all')) return true;
  if (role != null && raw.includes(role)) return true;
  const pid = deptPanel(dept);
  if (pid != null && raw.includes(pid)) return true;
  if (panel && panel !== 'all' && panel !== 'super_admin' && raw.includes(panel)) return true;
  return false;
}

export const createNotice = async (data) => {
  const { data: result, error } = await db
    .from('notices')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllNotices = async (ngo_id, target_role, user) => {
  let query = db
    .from('notices')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (ngo_id) query = query.or(`ngo_id.eq.${ngo_id},ngo_id.is.null`);
  const { data, error } = await query;
  if (error) throw error;
  if (user?.role === 'super_admin') return data;
  const role = sanitizeRole(user?.role || target_role);
  if (role && role !== 'all') return (data || []).filter(n => noticeMatchesRole(n, role, user?.department, target_role));
  return data;
};

export const getRecentNotices = async (ngo_id, since, target_role, user) => {
  let query = db
    .from('notices')
    .select('*')
    .eq('is_active', true)
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  if (user?.role === 'super_admin') return data;
  const role = sanitizeRole(user?.role || target_role);
  if (role && role !== 'all') return (data || []).filter(n => noticeMatchesRole(n, role, user?.department, target_role));
  return data;
};

export const getNoticeById = async (id) => {
  const { data, error } = await db
    .from('notices')
    .select('*')
    .eq('id', id);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0];
};

export const updateNotice = async (id, updates) => {
  const { data, error } = await db
    .from('notices')
    .update(updates)
    .eq('id', id)
    .select();
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0];
};

export const deleteNotice = async (id) => {
  const { data, error } = await db
    .from('notices')
    .delete()
    .eq('id', id)
    .select();
  if (error) throw error;
  if (!data || data.length === 0) return { message: 'Notice not found' };
  return { message: 'Notice deleted' };
};

export const getSeenNoticeIds = async (userId) => {
  if (userId == null) return new Set();
  const { rows } = await db._pool.query(
    'SELECT notice_id FROM notice_seen WHERE user_id = $1',
    [userId]
  );
  return new Set(rows.map(r => String(r.notice_id)));
};

export const markNoticeSeen = async (userId, noticeId) => {
  if (userId == null || noticeId == null) return;
  await db._pool.query(
    'INSERT INTO notice_seen (notice_id, user_id) VALUES ($1, $2) ON CONFLICT (notice_id, user_id) DO NOTHING',
    [noticeId, userId]
  );
};
