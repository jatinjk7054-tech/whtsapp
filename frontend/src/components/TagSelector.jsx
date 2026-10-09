import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../lib/api.js';
import { TAG_COLOR_PALETTE, normalizeHex } from '../lib/tags.js';
import TagChip from './TagChip.jsx';

/**
 * §2 — the small tag selector behind "[+ Add Tag]".
 *
 * Lists the whole catalogue with checkboxes (one or many can be picked) and
 * offers "Create New Tag", which saves the tag to the database so every future
 * conversation can use it. Nothing here is local-only: Apply posts the changes
 * to the backend and hands the authoritative tag list straight back.
 *
 * The popover is portalled to <body> so the profile modal's `overflow: auto`
 * cannot clip it; it is placed from the trigger's position and flips upward
 * when there is more room above than below.
 */
export default function TagSelector({ tags = [], selectedIds = [], onApply, onCreateTag }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [picked, setPicked] = useState(() => new Set(selectedIds));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_COLOR_PALETTE[7]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [localTags, setLocalTags] = useState(tags);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => setLocalTags(tags), [tags]);

  // A click outside closes the selector (same pattern as the chat header's
  // message search). The popover lives outside the trigger in the DOM, so both
  // containers count as "inside".
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      const insideWrap = wrapRef.current?.contains(event.target);
      const insidePop = popRef.current?.contains(event.target);
      if (!insideWrap && !insidePop) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const openPicker = () => {
    setPicked(new Set(selectedIds));
    setError(null);
    setCreating(false);
    setAnchor(wrapRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  };

  const toggle = (tagId) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onApply?.([...picked]);
      setOpen(false);
      setCreating(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Tags could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const create = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    try {
      const tag = await onCreateTag?.({ name: trimmed, color: normalizeHex(color) ?? undefined });
      if (tag) {
        setLocalTags((prev) => (prev.some((item) => item.id === tag.id) ? prev : [...prev, tag]));
        setPicked((prev) => new Set(prev).add(tag.id));
        setName('');
        setCreating(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Tag could not be created');
    } finally {
      setBusy(false);
    }
  };

  // Placement: below the button by default, above it when that side has more
  // room; never wider than the viewport.
  let popStyle = null;
  if (anchor) {
    const width = Math.max(anchor.width, 240);
    const left = Math.min(anchor.left, window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    const flip = spaceBelow < 300 && spaceAbove > spaceBelow;
    popStyle = flip
      ? {
          left,
          bottom: window.innerHeight - anchor.top + 6,
          width,
          maxHeight: Math.max(200, spaceAbove - 16),
        }
      : {
          left,
          top: anchor.bottom + 6,
          width,
          maxHeight: Math.max(200, spaceBelow - 16),
        };
  }

  return (
    <div className="tag-select-wrap" ref={wrapRef}>
      <button
        type="button"
        className="tag-add-button"
        onClick={open ? () => setOpen(false) : openPicker}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        + Add Tag
      </button>

      {open &&
        popStyle &&
        createPortal(
          <div className="tag-popover" ref={popRef} style={popStyle} role="dialog" aria-label="Choose tags">
            <div className="tag-popover-title">Tags</div>

            <div className="tag-popover-list">
              {localTags.length === 0 && <p className="modal-muted">No tags yet.</p>}
              {localTags.map((tag) => (
                <label key={tag.id} className="tag-option">
                  <input
                    type="checkbox"
                    checked={picked.has(tag.id)}
                    onChange={() => toggle(tag.id)}
                  />
                  <TagChip tag={tag} size="sm" />
                </label>
              ))}
            </div>

            {error && <p className="composer-error">{error}</p>}

            <div className="tag-popover-foot">
              <button
                type="button"
                className="ghost-button compact"
                onClick={() => setCreating((value) => !value)}
              >
                Create New Tag
              </button>
              <button type="button" className="primary-button compact" onClick={apply} disabled={busy}>
                {busy ? 'Saving…' : 'Apply'}
              </button>
            </div>

            {creating && (
              <form className="tag-create" onSubmit={create}>
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Tag name, e.g. Volunteer"
                  maxLength={40}
                  autoComplete="off"
                />
                <div className="tag-swatches" role="group" aria-label="Tag colour">
                  {TAG_COLOR_PALETTE.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      className={`tag-swatch${color === swatch ? ' is-active' : ''}`}
                      style={{ background: swatch }}
                      onClick={() => setColor(swatch)}
                      aria-label={`Colour ${swatch}`}
                      aria-pressed={color === swatch}
                    />
                  ))}
                </div>
                <div className="send-actions">
                  <button
                    type="button"
                    className="ghost-button compact"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="primary-button compact"
                    disabled={!name.trim() || busy}
                  >
                    Create
                  </button>
                </div>
              </form>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
