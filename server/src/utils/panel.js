// Resolve which panel a ticket reply came from, based on the logged-in user's
// role/department. Mirrors the role assignment in authController.unifiedLogin.

const PANEL_MAP = {
  fro: 'fro',
  accounts: 'accounts',
  admin: 'ngo_admin',
  ngo_admin: 'ngo_admin',
  recruiter: 'recruiter',
  hr: 'hr',
  event_head: 'event_head',
  digital: 'dev_panel',
  developers: 'dev_panel',
  super_admin: 'dev_panel',
  worker: 'other',
  user: 'other',
};

export const getSenderPanel = (user) => {
  const role = String(user?.role || '').toLowerCase().trim();
  if (role && PANEL_MAP[role]) return PANEL_MAP[role];

  const dept = String(user?.department || '').toLowerCase().trim();
  if (dept === 'fro') return 'fro';
  if (dept === 'hr' || dept.includes('hr')) return 'hr';
  if (dept.includes('recruit')) return 'recruiter';
  if (dept === 'account' || dept === 'accounts' || dept === 'admin') return 'accounts';
  if (dept === 'ngo admin') return 'ngo_admin';
  if (dept === 'digital' || dept.includes('develop')) return 'dev_panel';
  if (dept.includes('event')) return 'event_head';

  return 'other';
};

export const getSenderName = (user) => {
  if (!user) return '';
  if (user.name) return user.name;
  if (user.login_id) return user.login_id;
  if (user.role === 'super_admin') return 'Super Admin';
  return '';
};