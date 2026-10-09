import { sendTextMessage } from '../lib/whatsapp/client.js';
import {
  confirmOutboundMessage,
  failOutboundMessage,
  insertOutboundMessage,
} from '../conversations/message.repository.js';
import { touchConversation } from '../conversations/conversation.repository.js';
import { insertAutomationLog } from '../automation/automation.repository.js';
import {
  claimAwaySend,
  DAY_NAMES,
  DEFAULT_TIMEZONE,
  getAwaySettings,
  releaseAwayClaim,
} from './away.repository.js';

/**
 * Module 9 — the Away Message is an automation too, so its outcome is recorded
 * in the shared automation log. A missing log table must never break the away
 * reply, hence the swallow-and-warn.
 */
async function logAwayMessage(entry) {
  try {
    await insertAutomationLog({ action: 'away_message', ...entry });
  } catch (error) {
    console.error('Automation log write failed:', error.message);
  }
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * "Now" for the schedule: wall-clock weekday + HH:MM inside the configured IANA
 * zone (default Asia/Kolkata), read from Intl so the server clock's own zone
 * never leaks into the decision. An unknown zone falls back to the default
 * instead of throwing inside the webhook.
 */
export function localClock(timeZone, now = new Date()) {
  const zone = timeZone || DEFAULT_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);

    const get = (type) => parts.find((part) => part.type === type)?.value;
    const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
    const time = `${get('hour')}:${get('minute')}`;
    // Module 9: the local calendar date, so a public holiday is compared against
    // the customer-facing timezone rather than the server's.
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    return { timezone: zone, weekday, dayName: DAY_NAMES[weekday], time, date, valid: true };
  } catch {
    return {
      timezone: zone,
      weekday: now.getDay(),
      dayName: DAY_NAMES[now.getDay()],
      time: '',
      date: '',
      valid: false,
    };
  }
}

const isTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/**
 * Pure decision function — no database, no sending — so the admin UI's
 * [Test Away Message] button can reuse exactly the code the webhook runs.
 *
 * Away reply fires only when ALL of these hold:
 *   A. the feature is enabled,
 *   B. today is an office day (or has no schedule entry) and not a public
 *      holiday (Module 9),
 *   C. the local time is outside that day's office hours.
 */
export function evaluateAwayWindow(settings, now = new Date()) {
  const clock = localClock(settings?.timezone, now);
  const entry = (settings?.schedule ?? []).find((day) => day.day === clock.weekday) ?? null;
  const dayEnabled = Boolean(entry?.enabled);
  const from = isTime(entry?.from) ? entry.from : null;
  const to = isTime(entry?.to) ? entry.to : null;

  // Module 9: a public holiday counts as a non-office day, exactly like an
  // out-of-hours window, so no separate business-hours feature is needed.
  const holidays = Array.isArray(settings?.holidays) ? settings.holidays : [];
  const isHoliday = Boolean(clock.date) && holidays.includes(clock.date);

  const officeDay = dayEnabled && !isHoliday;
  const insideOfficeHours = officeDay && from !== null && to !== null
    ? clock.time >= from && clock.time < to
    : false;

  const enabled = Boolean(settings?.enabled);
  const hasMessage = Boolean(settings?.message?.trim());
  const shouldSend = enabled && hasMessage && !insideOfficeHours;

  let reason;
  if (!enabled) reason = 'Away Message is disabled';
  else if (!hasMessage) reason = 'Away Message text is empty';
  else if (insideOfficeHours) reason = `Inside office hours (${from}–${to} ${clock.dayName})`;
  else if (!clock.valid) reason = `Unknown timezone "${clock.timezone}", using server time`;
  else if (isHoliday) reason = `${clock.date} is a public holiday`;
  else reason = dayEnabled ? `Outside office hours (${from}–${to} ${clock.dayName})` : `${clock.dayName} is not an office day`;

  return {
    enabled,
    timezone: clock.timezone,
    validTimezone: clock.valid,
    weekday: clock.weekday,
    dayName: clock.dayName,
    date: clock.date,
    localTime: clock.time,
    day: entry ? { ...entry } : null,
    dayEnabled,
    isHoliday,
    holidays,
    from,
    to,
    insideOfficeHours,
    outsideOfficeHours: !insideOfficeHours,
    shouldSend,
    reason,
  };
}

/**
 * Automatic reply to a genuine customer inbound message.
 *
 * Called only from handleInbound(), so agent/admin sends, template sends,
 * delivery/read/failed status webhooks and our own away messages (which are
 * `direction = 'outbound'`) can never re-enter it — there is no loop.
 *
 * The 24-hour cooldown lives in `conversations.last_away_sent_at` and is
 * claimed with a conditional UPDATE, so bursts of messages produce exactly one
 * away message per customer per day.
 */
export async function maybeSendAwayMessage(
  conversation,
  { now = new Date(), triggerMessageId = null } = {}
) {
  const settings = await getAwaySettings();
  const evaluation = evaluateAwayWindow(settings, now);

  if (!evaluation.shouldSend) return { sent: false, reason: evaluation.reason };

  // Claim first: a second webhook racing us loses here, before anything is
  // written or sent.
  if (!(await claimAwaySend(conversation.id))) {
    return { sent: false, reason: 'cooldown: already sent within the last 24 hours' };
  }

  const body = settings.message.trim();
  if (!body) {
    await releaseAwayClaim(conversation.id);
    return { sent: false, reason: 'Away Message text is empty' };
  }

  const messageId = await insertOutboundMessage({
    conversationId: conversation.id,
    sentByStaffId: null,
    type: 'text',
    body,
    mediaUrl: null,
  });

  try {
    // Same Cloud API client and same outbound row lifecycle as every CRM send.
    // It runs immediately after an inbound message, i.e. inside the open
    // customer-care window — it is never a way around the 24-hour policy.
    const response = await sendTextMessage({ to: conversation.contact_wa_id, body });
    const waMessageId = response.messages?.[0]?.id ?? null;
    await confirmOutboundMessage(messageId, waMessageId);
    await touchConversation(conversation.id, body);
    await logAwayMessage({
      result: 'sent',
      conversationId: conversation.id,
      contactId: conversation.contact_id ?? null,
      triggerMessageId,
      messageId,
      waMessageId,
      detail: evaluation.reason,
    });
    return { sent: true, messageId, evaluation };
  } catch (error) {
    await failOutboundMessage(messageId, error.code, error.message);
    // Nothing went out: hand the cooldown back so the next customer message
    // can try again.
    await releaseAwayClaim(conversation.id);
    await logAwayMessage({
      result: 'failed',
      conversationId: conversation.id,
      contactId: conversation.contact_id ?? null,
      triggerMessageId,
      messageId,
      detail: error.message,
    });
    console.error('Away message failed:', error.message);
    return { sent: false, reason: `send failed: ${error.message}` };
  }
}

export { getAwaySettings };
