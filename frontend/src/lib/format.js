const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function sameDay(a, b) {
  return startOfDay(a) === startOfDay(b);
}

/** Clock time, e.g. "4:35 PM". */
export function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Compact stamp for the conversation list: time today, weekday this week, else a date. */
export function formatListStamp(value) {
  if (!value) return '';

  const date = new Date(value);
  const now = new Date();

  if (sameDay(date, now)) return formatTime(value);
  if (now.getTime() - date.getTime() < 6 * DAY) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

/** Full stamp with a day prefix once the message is no longer from today. */
export function formatMessageStamp(value) {
  if (!value) return '';
  const date = new Date(value);

  if (sameDay(date, new Date())) return formatTime(value);
  if (new Date().getTime() - date.getTime() < 6 * DAY) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })}, ${formatTime(value)}`;
  }
  return `${date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}, ${formatTime(value)}`;
}

/**
 * The backend stores the address as a bare E.164 string (contacts.wa_id). We add
 * the "+" the customer expects to read but never reformat the digits, so what is
 * shown always matches what is sent to WhatsApp.
 */
export function formatWaId(waId) {
  if (!waId) return 'Unknown number';
  return waId.startsWith('+') ? waId : `+${waId}`;
}

/** Full date + time, e.g. "08 Oct 2026, 4:35 PM" — for first-contact timestamps. */
export function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Up to two letters for the avatar circle. */export function initials(name, fallback = '?') {
  const source = (name ?? '').trim();
  if (!source) return fallback;

  const parts = source.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || fallback;
}

/** Deterministic hue per contact so avatars stay stable between renders. */
export function colorFor(seed) {
  const value = String(seed ?? '');
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 52% 42%)`;
}

export const MESSAGE_TYPE_LABELS = {
  image: 'Photo',
  audio: 'Audio',
  video: 'Video',
  document: 'Document',
  sticker: 'Sticker',
};

export const STATUS_LABELS = {
  open: 'Open',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
};

/**
 * Human duration for the agent performance dashboard, e.g. "5m 12s". Seconds
 * below the minute show "<1m", and null (no responses) becomes "—".
 */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return '<1m';
  if (rest === 0) return `${minutes}m`;
  return `${minutes}m ${rest}s`;
}