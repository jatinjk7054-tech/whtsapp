import db from '../config/db.js';

const TABLE = 'reminders';
const HISTORY_TABLE = 'reminder_history';
const NOTIFICATION_TABLE = 'reminder_notifications';
const SETTINGS_TABLE = 'reminder_settings';
const DEVICE_TOKEN_TABLE = 'reminder_device_tokens';
const ALERT_LOG_TABLE = 'reminder_alert_log';

export const createReminder = async (data, userId) => {
  const { data: result, error } = await db
    .from(TABLE)
    .insert([{ ...data, created_by: userId }])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getAllReminders = async (includeDeleted = false) => {
  let q = db.from(TABLE).select('*').order('due_date', { ascending: true, nullsFirst: true });
  if (!includeDeleted) q = q.eq('is_deleted', false);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  // Deduplicate rows that describe the same reminder (same title + category +
  // owner + source_section, compared case-insensitively after collapsing
  // whitespace/dashes), keeping the row with the most data (due date / amount /
  // due-date text), tie-broken by lowest id. Guards against migrations/imports
  // being run more than once, which would otherwise double every reminder
  // across all clients. source_section is part of the key so the sparse Finance
  // rows (same bare titles under Income Tax / Advance Tax / Accounts and Audit
  // Fees) stay distinct, matching the client-side dedupe in store.jsx.
  const norm = (s) => String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^a-z0-9\s-]/g, '');
  const score = (r) =>
    (r.due_date ? 4 : 0) +
    (Number(r.amount) > 0 ? 2 : 0) +
    (r.due_date_display ? 1 : 0);
  const seen = new Map();
  for (const r of rows) {
    const key = `${norm(r.title)}||${norm(r.category)}||${norm(r.owner)}||${norm(r.source_section)}`;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, r); continue; }
    const sa = score(prev), sb = score(r);
    if (sa !== sb) seen.set(key, sa > sb ? prev : r);
    else seen.set(key, r.id < prev.id ? r : prev);
  }
  return Array.from(seen.values());
};

export const getReminderById = async (id) => {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const updateReminder = async (id, updates) => {
  const { data, error } = await db
    .from(TABLE)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const softDeleteReminder = async (id) => {
  const { data, error } = await db
    .from(TABLE)
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const bulkInsertReminders = async (rows) => {
  const { data, error } = await db.from(TABLE).insert(rows).select();
  if (error) throw error;
  return data || [];
};

export const createReminderHistory = async (entry) => {
  const { data, error } = await db
    .from(HISTORY_TABLE)
    .insert([entry])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getReminderHistory = async (reminderId) => {
  const { data, error } = await db
    .from(HISTORY_TABLE)
    .select('*')
    .eq('reminder_id', reminderId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const createNotification = async (entry) => {
  const { data, error } = await db
    .from(NOTIFICATION_TABLE)
    .insert([entry])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getNotificationsForReminder = async (reminderId) => {
  const { data, error } = await db
    .from(NOTIFICATION_TABLE)
    .select('*')
    .eq('reminder_id', reminderId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getAllNotifications = async (onlyUnread = false) => {
  let q = db.from(NOTIFICATION_TABLE).select('*').order('created_at', { ascending: false });
  if (onlyUnread) q = q.eq('read', false);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
};

export const markNotificationRead = async (id) => {
  const { data, error } = await db
    .from(NOTIFICATION_TABLE)
    .update({ read: true })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const markAllNotificationsRead = async () => {
  const { data, error } = await db
    .from(NOTIFICATION_TABLE)
    .update({ read: true })
    .neq('read', true)
    .select();
  if (error) throw error;
  return data || [];
};

export const clearNotification = async (id) => {
  const { error } = await db.from(NOTIFICATION_TABLE).delete().eq('id', id);
  if (error) throw error;
  return { message: 'Notification cleared' };
};

export const getSettings = async (userKey) => {
  let q = db.from(SETTINGS_TABLE).select('*').limit(1);
  if (userKey) q = q.eq('user_key', userKey);
  const { data, error } = await q;
  if (error) throw error;
  return (data && data[0]) || null;
};

export const upsertSettings = async (settings) => {
  const existing = await getSettings(settings.user_key || null);
  if (existing) {
    const { data, error } = await db
      .from(SETTINGS_TABLE)
      .update({ ...settings, id: undefined, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db
    .from(SETTINGS_TABLE)
    .insert([{ ...settings, updated_at: new Date().toISOString() }])
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ---- Reminder mobile push (Bill Reminder Flutter app) ----

export const registerDeviceToken = async (token, deviceType = 'flutter') => {
  const { data, error } = await db
    .from(DEVICE_TOKEN_TABLE)
    .upsert({ token, device_type: deviceType, updated_at: new Date().toISOString() }, { onConflict: 'token' })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const removeDeviceToken = async (token) => {
  const { error } = await db.from(DEVICE_TOKEN_TABLE).delete().eq('token', token);
  if (error) throw error;
  return { message: 'Device token removed' };
};

export const listDeviceTokens = async () => {
  const { data, error } = await db.from(DEVICE_TOKEN_TABLE).select('token');
  if (error) throw error;
  return (data || []).map((r) => r.token);
};

export const hasAlertBeenSent = async (reminderId, alertType, sentDate) => {
  const { data, error } = await db
    .from(ALERT_LOG_TABLE)
    .select('id')
    .eq('reminder_id', reminderId)
    .eq('alert_type', alertType)
    .eq('sent_date', sentDate);
  if (error) throw error;
  return (data || []).length > 0;
};

export const markAlertSent = async (reminderId, alertType, sentDate) => {
  const { data, error } = await db
    .from(ALERT_LOG_TABLE)
    .insert({ reminder_id: reminderId, alert_type: alertType, sent_date: sentDate })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Clear today's alert-log rows for a reminder so the scheduler can re-alert
// once a snooze expires (the daily dedupe would otherwise suppress it).
export const clearAlertLogForReminder = async (reminderId, sentDate) => {
  const { error } = await db
    .from(ALERT_LOG_TABLE)
    .delete()
    .eq('reminder_id', reminderId)
    .eq('sent_date', sentDate);
  if (error) throw error;
  return true;
};
