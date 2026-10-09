/**
 * Module 5 — the single place that knows how a tag should look.
 *
 * Nothing else in the app hardcodes a tag colour: components ask for a style
 * here (or render <TagChip>), so the palette stays consistent and a colour
 * change in the database is picked up everywhere at once.
 */

/** §3 — the prescribed colours for the five default tags. */
export const DEFAULT_TAG_COLORS = {
  New: '#16a34a',
  Donation: '#2563eb',
  'Follow-up': '#eab308',
  Urgent: '#dc2626',
  Pending: '#f97316',
};

/** Palette offered in the "create tag" and admin colour pickers. */
export const TAG_COLOR_PALETTE = [
  '#16a34a',
  '#2563eb',
  '#eab308',
  '#dc2626',
  '#f97316',
  '#00a884',
  '#8b5cf6',
  '#ec4899',
  '#6b7280',
];

export const FALLBACK_TAG_COLOR = '#8696a0';

const HEX = /^#[0-9a-fA-F]{6}$/;

export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Colour for a tag object or a bare tag name, falling back through the palette. */
export function tagColor(tag) {
  if (!tag) return FALLBACK_TAG_COLOR;
  const name = typeof tag === 'string' ? tag : tag?.name;
  const color = typeof tag === 'string' ? null : normalizeHex(tag?.color);

  return (
    color ??
    normalizeHex(DEFAULT_TAG_COLORS[name]) ??
    (name ? normalizeHex(DEFAULT_TAG_COLORS[String(name).trim()]) : null) ??
    FALLBACK_TAG_COLOR
  );
}

function shift(hex, target, amount) {
  const value = hex.slice(1);
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  const mixed = channels.map((channel) =>
    Math.round(channel + (target - channel) * amount)
  );
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** The inbox is dark, so chip text is the tag colour lifted towards white. */
export function lighten(hex, amount) {
  return shift(hex, 255, amount);
}

export function darken(hex, amount) {
  return shift(hex, 0, amount);
}

/**
 * Inline style for a tag chip: a tinted background, a matching border and a
 * readable text colour — all derived from the one stored hex value.
 */
export function tagStyle(tag) {
  const color = tagColor(tag);
  return {
    backgroundColor: `${color}1f`,
    borderColor: `${color}66`,
    color: lighten(color, 0.35),
  };
}
