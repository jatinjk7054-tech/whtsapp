import { messaging } from '../config/firebase.js';
import { logNotification } from '../models/notificationModel.js';

// ==== MASTER SWITCH ====
// Notifications are ON by default. Set NOTIFICATIONS_ENABLED=false in the
// environment to disable all FCM push delivery + notification_log writes.
const NOTIFICATIONS_ENABLED = process.env.NOTIFICATIONS_ENABLED !== 'false';

export const sendPushNotification = async (workerId, title, body, type, referenceId = null) => {
  try {
    if (!NOTIFICATIONS_ENABLED) {
      return null;
    }

    const cleanTitle = String(title == null ? '' : title).trim();
    const cleanBody = String(body == null ? '' : body).trim();
    if (!cleanTitle) {
      console.log('Skipping push: empty notification title');
      return null;
    }

    if (!messaging) {
      console.log('Firebase not initialized, skipping push');
      return null;
    }

    const { getFcmToken } = await import('../models/notificationModel.js');
    const tokenData = await getFcmToken(workerId);
    if (!tokenData) {
      console.log(`No FCM token for worker ${workerId}`);
      return null;
    }

    const message = {
      token: tokenData.token,
      notification: { title: cleanTitle, body: cleanBody },
      data: {
        type: type || 'general',
        referenceId: referenceId || '',
        workerId: workerId || '',
      },
    };

    const response = await messaging.send(message);

    await logNotification({
      worker_id: workerId,
      type: type || 'general',
      title: cleanTitle,
      body: cleanBody,
      reference_id: referenceId,
    });

    return response;
  } catch (error) {
    if (error.code === 'messaging/registration-token-not-registered') {
      console.log(`FCM token invalid for worker ${workerId}, removing...`);
      const db = (await import('../config/db.js')).default;
      await db.from('fcm_tokens').delete().eq('worker_id', workerId);
    }
    console.error('FCM send error:', error.message);
    return null;
  }
};

// Concurrency for the fan-out below. High enough that 60 devices are not sent
// serially, low enough that a burst of notifications cannot saturate the
// event loop or open a pile of sockets on a 2 GB host.
const PUSH_FANOUT_CONCURRENCY = 8;

/**
 * Runs `worker` over `items` with a bounded number in flight.
 * Deliberately not Promise.all: one slow or hanging FCM call must not hold the
 * whole batch, and an unbounded Promise.all over hundreds of devices is its own
 * outage on a small box.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export const sendPushToMultiple = async (notifications) => {
  // Was a plain `for ... await`, i.e. one FCM HTTP round-trip at a time. The
  // 5-min scheduled-notification cron calls this once per pending notification
  // with every registered token, so 60 workers x 3 notifications meant 180
  // serial blocking HTTP calls holding the event loop — a recurring CPU spike
  // on the host, and the reason that cron was measured as slow.
  return mapWithConcurrency(notifications || [], PUSH_FANOUT_CONCURRENCY, (n) =>
    sendPushNotification(n.workerId, n.title, n.body, n.type, n.referenceId)
  );
};

// Always records a notification_log row (drives the FRO web bell + realtime
// toast via the socket broadcast) and additionally attempts an FCM push when
// a mobile token exists. Unlike sendPushNotification, the log is written even
// without a token so web-only FROs still receive the alert.
export const notifyWorker = async (workerId, title, body, type, referenceId = null) => {
  try {
    const cleanTitle = String(title == null ? '' : title).trim();
    const cleanBody = String(body == null ? '' : body).trim();
    if (!workerId || !cleanTitle) return null;

    const { logNotification, getFcmToken } = await import('../models/notificationModel.js');
    const entry = await logNotification({
      worker_id: workerId,
      type: type || 'general',
      title: cleanTitle,
      body: cleanBody,
      reference_id: referenceId,
    });

    try {
      if (NOTIFICATIONS_ENABLED && messaging) {
        const tokenData = await getFcmToken(workerId);
        if (tokenData?.token) {
          await messaging.send({
            token: tokenData.token,
            notification: { title: cleanTitle, body: cleanBody },
            data: { type: type || 'general', referenceId: referenceId || '', workerId: workerId || '' },
          });
        }
      }
    } catch (pushErr) {
      console.error('FCM send error (notifyWorker):', pushErr.message);
    }
    return entry;
  } catch (error) {
    console.error('notifyWorker failed:', error.message);
    return null;
  }
};
