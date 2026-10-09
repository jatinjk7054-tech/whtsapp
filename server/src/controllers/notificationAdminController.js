import {
  createScheduledNotification,
  getScheduledNotifications,
  cancelScheduledNotification,
  deleteScheduledNotification,
} from '../models/notificationAdminModel.js';
import { getAllFcmTokens, getFcmToken } from '../models/notificationModel.js';
import { sendPushToMultiple, sendPushNotification } from '../services/fcmService.js';
import db from '../config/db.js';

export const sendNow = async (req, res) => {
  try {
    const { title, body, worker_id, role } = req.body;
    if (!title || !body) {
      return res.status(400).json({ message: 'Title and body are required' });
    }

    if (worker_id) {
      const result = await sendPushNotification(worker_id, title, body, 'admin');
      return res.json({ message: 'Notification sent', sent: result ? 1 : 0 });
    }

    if (role) {
      const { data: users } = await db
        .from('users')
        .select('id')
        .eq('role', role);
      const workerIds = (users || []).map(u => u.id);
      if (workerIds.length === 0) return res.json({ message: 'No users with role ' + role, sent: 0 });
      for (const wid of workerIds) {
        try { await sendPushNotification(wid, title, body, 'admin'); } catch {}
      }
      return res.json({ message: 'Notification sent to ' + role, sent: workerIds.length });
    }

    const tokens = await getAllFcmTokens();
    if (!tokens || tokens.length === 0) {
      return res.status(200).json({ message: 'No workers with FCM tokens', sent: 0 });
    }
    const notifications = tokens.map((t) => ({
      workerId: t.worker_id,
      title,
      body,
      type: 'admin',
      referenceId: null,
    }));
    await sendPushToMultiple(notifications);
    return res.json({ message: 'Notification sent', sent: notifications.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const scheduleNotification = async (req, res) => {
  try {
    const { title, body, scheduled_at } = req.body;
    if (!title || !body || !scheduled_at) {
      return res.status(400).json({ message: 'Title, body, and scheduled_at are required' });
    }
    const notification = await createScheduledNotification({
      title,
      body,
      recipient_type: 'all_workers',
      scheduled_at,
      ngo_id: req.user.ngo_id || req.body.ngo_id || null,
      created_by: req.user.id,
    });
    return res.status(201).json({ message: 'Notification scheduled', notification });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listScheduledNotifications = async (req, res) => {
  try {
    const ngoId = req.user.role === 'super_admin' ? req.query.ngo_id : req.user.ngo_id;
    const notifications = await getScheduledNotifications(ngoId);
    return res.json(notifications);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const cancelScheduled = async (req, res) => {
  try {
    const notification = await cancelScheduledNotification(req.params.id);
    return res.json({ message: 'Notification cancelled', notification });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeScheduled = async (req, res) => {
  try {
    const result = await deleteScheduledNotification(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
