import db from '../config/db.js';

export const createScheduledNotification = async (data) => {
  const { data: result, error } = await db
    .from('scheduled_notifications')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return result;
};

export const getScheduledNotifications = async (ngo_id) => {
  let query = db
    .from('scheduled_notifications')
    .select('*')
    .order('scheduled_at', { ascending: false });
  if (ngo_id) query = query.eq('ngo_id', ngo_id);
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const getPendingScheduledNotifications = async () => {
  const { data, error } = await db
    .from('scheduled_notifications')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString());
  if (error) throw error;
  return data;
};

export const markNotificationSent = async (id) => {
  const { data, error } = await db
    .from('scheduled_notifications')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const cancelScheduledNotification = async (id) => {
  const { data, error } = await db
    .from('scheduled_notifications')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteScheduledNotification = async (id) => {
  const { error } = await db
    .from('scheduled_notifications')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'Notification deleted' };
};
