import { tagStyle } from '../lib/tags.js';

/**
 * The one tag rendering used by the customer profile, the conversation list
 * and the tag menus. Colours come from lib/tags.js, so no component hardcodes
 * a palette. `size="sm"` keeps the inbox rows compact (§4).
 */
export default function TagChip({ tag, size = 'md', onRemove, title }) {
  const name = typeof tag === 'string' ? tag : tag?.name;
  if (!name) return null;

  return (
    <span
      className={`tag-chip${size === 'sm' ? ' tag-chip-sm' : ''}`}
      style={tagStyle(tag)}
      title={title ?? (typeof tag === 'string' ? name : `${name} — internal tag, never sent to the customer`)}
    >
      <span className="tag-chip-label">{name}</span>
      {onRemove && (
        <button
          type="button"
          className="tag-chip-remove"
          aria-label={`Remove ${name} tag`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
