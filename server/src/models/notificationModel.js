import db from '../config/db.js';

export const upsertFcmToken = async (worker_id, token, device_type = 'flutter') => {
  const { data, error } = await db
    .from('fcm_tokens')
    .upsert({ worker_id, token, device_type }, { onConflict: 'worker_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getFcmToken = async (worker_id) => {
  const { data, error } = await db
    .from('fcm_tokens')
    .select('token')
    .eq('worker_id', worker_id)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const getAllFcmTokens = async () => {
  const { data, error } = await db
    .from('fcm_tokens')
    .select('worker_id, token, workers!inner(ngo_id, name)');
  if (error) throw error;
  return data;
};

// The notification_log table was retired, so this no longer records anything.
// The signature is kept because callers (fcmService, chat notifications,
// incentive broadcasts) still call it; they must not start failing because a
// feature was turned off. Returns a shape that satisfies the old .single()
// read-back so no caller has to change.
export const logNotification = async (entry) => {
  if (process.env.NOTIFICATION_LOG_RETIRED !== 'off') {
    return { id: null, worker_id: entry?.worker_id ?? null, type: entry?.type ?? null, sent_at: new Date().toISOString() };
  }
  const { data, error } = await db
    .from('notification_log')
    .insert([entry])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getWorkerNotifications = async (worker_id, limit = 50) => {
  const { data, error } = await db
    .from('notification_log')
    .select('*')
    .eq('worker_id', worker_id)
    .order('sent_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
};

export const markNotificationRead = async (id) => {
  const { error } = await db
    .from('notification_log')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  return { message: 'Marked as read' };
};

export const getUnreadNotificationCount = async (worker_id) => {
  const { count, error } = await db
    .from('notification_log')
    .select('*', { count: 'exact', head: true })
    .eq('worker_id', worker_id)
    .is('read_at', null);
  if (error) throw error;
  return count || 0;
};

export const deleteNotification = async (id, workerId) => {
  const { error } = await db
    .from('notification_log')
    .delete()
    .eq('id', id)
    .eq('worker_id', workerId);
  if (error) throw error;
  return { message: 'Notification deleted' };
};
