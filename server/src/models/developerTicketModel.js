import db from '../config/db.js';

export const insertDeveloperTicket = async (ticket) => {
  const { data, error } = await db
    .from('developer_tickets')
    .insert(ticket)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const selectDeveloperTickets = async (filters = {}) => {
  let query = db
    .from('developer_tickets')
    .select('*, workers!developer_tickets_raised_by_fkey(name, login_id, department), assigned_worker:workers!developer_tickets_assigned_to_fkey(name, login_id)')
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.priority) query = query.eq('priority', filters.priority);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.assigned_to) query = query.eq('assigned_to', filters.assigned_to);
  if (filters.raised_by_panel) query = query.eq('raised_by_panel', filters.raised_by_panel);
  if (filters.raised_by) query = query.eq('raised_by', filters.raised_by);
  if (filters.search) {
    query = query.or(`subject.ilike.%${filters.search}%,description.ilike.%${filters.search}%,reference_id.ilike.%${filters.search}%`);
  }
  if (filters.date_from) query = query.gte('created_at', filters.date_from);
  if (filters.date_to) query = query.lte('created_at', filters.date_to);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const selectDeveloperTicketById = async (id) => {
  const { data, error } = await db
    .from('developer_tickets')
    .select('*, workers!developer_tickets_raised_by_fkey(name, login_id, department), assigned_worker:workers!developer_tickets_assigned_to_fkey(name, login_id)')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateDeveloperTicket = async (id, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('developer_tickets')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const insertDeveloperTicketReply = async (reply) => {
  const { data, error } = await db
    .from('developer_ticket_replies')
    .insert(reply)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const selectDeveloperTicketReplies = async (ticketId, includeInternal = false) => {
  let query = db
    .from('developer_ticket_replies')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (!includeInternal) query = query.eq('is_internal', false);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

export const getDeveloperTicketStats = async () => {
  const { data: tickets, error } = await db
    .from('developer_tickets')
    .select('status, priority, category, raised_by_panel, created_at, first_response_at, resolved_at');
  if (error) throw error;

  const all = tickets || [];
  const now = new Date();

  const countBy = (field, value) => all.filter(t => t[field] === value).length;

  const responseTimes = all
    .filter(t => t.first_response_at)
    .map(t => (new Date(t.first_response_at) - new Date(t.created_at)) / 60000);
  const resolutionTimes = all
    .filter(t => t.resolved_at)
    .map(t => (new Date(t.resolved_at) - new Date(t.created_at)) / 60000);

  const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;

  const trend = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    trend[key] = 0;
  }
  all.forEach(t => {
    const key = t.created_at?.slice(0, 10);
    if (key && trend[key] !== undefined) trend[key]++;
  });

  return {
    total: all.length,
    open: countBy('status', 'open'),
    in_progress: countBy('status', 'in_progress'),
    under_review: countBy('status', 'under_review'),
    resolved: countBy('status', 'resolved'),
    closed: countBy('status', 'closed'),
    by_priority: {
      low: countBy('priority', 'low'),
      medium: countBy('priority', 'medium'),
      high: countBy('priority', 'high'),
      critical: countBy('priority', 'critical'),
    },
    by_category: {
      bug: countBy('category', 'bug'),
      feature_request: countBy('category', 'feature_request'),
      enhancement: countBy('category', 'enhancement'),
      data_issue: countBy('category', 'data_issue'),
      payment_issue: countBy('category', 'payment_issue'),
      technical: countBy('category', 'technical'),
      other: countBy('category', 'other'),
    },
    by_panel: {
      fro: countBy('raised_by_panel', 'fro'),
      accounts: countBy('raised_by_panel', 'accounts'),
      ngo_admin: countBy('raised_by_panel', 'ngo_admin'),
    },
    avg_response_minutes: avg(responseTimes),
    avg_resolution_minutes: avg(resolutionTimes),
    trend,
  };
};

export const bulkUpdateDeveloperTickets = async (ids, updates) => {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from('developer_tickets')
    .update(updates)
    .in('id', ids)
    .select();
  if (error) throw error;
  return data || [];
};

export const getDeveloperTeamMembers = async () => {
  const { data, error } = await db
    .from('workers')
    .select('id, name, login_id, department')
    .or('department.eq.digital,department.eq.developers')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
};
