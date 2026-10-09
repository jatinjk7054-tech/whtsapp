// Reminder push scheduler — sends FCM alerts to the Bill Reminder Flutter app.
// Mirrors the web app's client-side alarm logic: OVERDUE, DUE_TODAY, DUE_SOON
// (and renewal-based alerts), deduped to fire each (reminder, type) once/day.
//
// Reads owner device tokens from reminder_device_tokens and sends via Firebase
// Admin messaging (same project the Flutter app subscribes to). Safe to run
// repeatedly — reminder_alert_log guards against duplicates.

import cron from 'node-cron';
import db from '../config/db.js';
import { messaging } from '../config/firebase.js';
import {
  getAllReminders,
  getSettings,
  listDeviceTokens,
  hasAlertBeenSent,
  markAlertSent,
  createNotification,
} from '../models/reminderModel.js';

const cronJobs = [];
let running = false;

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateOnly(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

// Determine which alert (if any) applies right now for this reminder.
function computeAlert(reminder, threshold, today) {
  const completedOrDeleted = reminder.completed_at || reminder.is_deleted;
  if (completedOrDeleted) return null;

  // Respect snooze: skip until snooze_until passes, then resume daily alerts.
  if (reminder.snooze_until) {
    const until = new Date(reminder.snooze_until);
    if (!isNaN(until.getTime()) && until.getTime() > today.getTime()) return null;
  }

  const todayStart = dateOnly(today);
  const due = parseDate(reminder.due_date);
  const renewal = parseDate(reminder.renewal_date);

  const dueDays = due ? daysBetween(due, todayStart) : null;
  if (dueDays != null) {
    if (dueDays < 0) return 'OVERDUE';
    if (dueDays === 0) return 'DUE_TODAY';
    if (dueDays <= threshold) return 'DUE_SOON';
  }

  // Renewal-date alerts: remind from the renewal date (due_minus_remind).
  if (renewal) {
    const rDays = daysBetween(renewal, todayStart);
    if (rDays != null && rDays >= 0 && rDays <= threshold) return 'DUE_SOON';
  }

  return null;
}

async function pushToDevices(title, body, type, reminderId) {
  const tokens = await listDeviceTokens();
  if (!tokens.length || !messaging) return 0;

  const cleanTitle = String(title == null ? '' : title).trim();
  const cleanBody = String(body == null ? '' : body).trim();
  if (!cleanTitle) return 0;

  let sent = 0;
  for (const token of tokens) {
    try {
      await messaging.send({
        token,
        // Data-only so the app builds the notification and can attach
        // Snooze action buttons (system-rendered FCM notifications can't).
        data: { type, reminderId: String(reminderId), title: cleanTitle, body: cleanBody },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default', 'content-available': 1 } } },
      });
      sent += 1;
    } catch (err) {
      if (err.code === 'messaging/registration-token-not-registered' ||
          err.code === 'messaging/invalid-registration-token') {
        try {
          await db.from('reminder_device_tokens').delete().eq('token', token);
        } catch (_) {}
      } else {
        console.error('Reminder push error:', err.message);
      }
    }
  }
  return sent;
}

export async function runReminderAlertCycle() {
  if (running) return;
  running = true;
  try {
    const reminders = await getAllReminders(false);
    const settings = await getSettings();
    // due_soon_days is the web-panel field; due_soon_threshold is the legacy name.
    const threshold = parseInt(settings?.due_soon_threshold ?? settings?.due_soon_days, 10) || 10;
    const todayKey = dateKey();
    const today = new Date();

    for (const r of reminders) {
      const alertType = computeAlert(r, threshold, today);
      if (!alertType) continue;

      const alreadySent = await hasAlertBeenSent(r.id, alertType, todayKey);
      if (alreadySent) continue;

      await markAlertSent(r.id, alertType, todayKey);

      const title = alertType === 'OVERDUE' ? 'OVERDUE' : alertType === 'DUE_TODAY' ? 'DUE TODAY' : 'DUE SOON';
      const label = alertType === 'OVERDUE' ? 'overdue' : alertType === 'DUE_TODAY' ? 'due today' : 'due soon';
      const body = `${r.title}${r.due_date ? ` — ${label} (${String(r.due_date).slice(0, 10)})` : ` — ${label}`}`;

      // Record the alert so the in-app Alerts list shows it (FCM push is best-effort).
      try {
        await createNotification({
          reminder_id: r.id,
          title,
          body,
          level: alertType,
          read: false,
        });
      } catch (e) {
        console.error('Reminder notification log error:', e.message);
      }

      await pushToDevices(title, body, alertType, r.id);
    }
  } catch (error) {
    console.error('Reminder alert cycle error:', error.message);
  } finally {
    running = false;
  }
}

export function startReminderNotificationScheduler() {
  cronJobs.push(cron.schedule('*/5 * * * *', () => runReminderAlertCycle()));
  runReminderAlertCycle().catch(() => {});
}

export function stopReminderNotificationScheduler() {
  for (const job of cronJobs) job.stop();
  cronJobs.length = 0;
}