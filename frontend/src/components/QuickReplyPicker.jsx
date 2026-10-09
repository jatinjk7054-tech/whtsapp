import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';

/**
 * Module 6 — Quick Replies popup in the composer.
 *
 * It only *inserts text*: nothing is sent from here. The agent sees the text in
 * the normal composer, edits it, and presses Send — which then goes through the
 * existing send path (and its existing 24-hour free-text rule).
 *
 * `{{name}}` / `{{phone}}` are filled from the open conversation. A variable
 * with no value never reaches the composer: the agent gets an editable field
 * (or, with `canInsert` false, is pointed at the Template Library).
 */

function fillVariables(message, values) {
  return String(message ?? '')
    .replace(/\{\{\s*name\s*\}\}/gi, values.name ?? '')
    .replace(/\{\{\s*phone\s*\}\}/gi, values.phone ?? '');
}

function variablesIn(message) {
  const text = String(message ?? '');
  const found = [];
  if (/\{\{\s*name\s*\}\}/i.test(text)) found.push({ key: 'name', label: 'Customer name' });
  if (/\{\{\s*phone\s*\}\}/i.test(text)) found.push({ key: 'phone', label: 'Customer phone' });
  return found;
}

export default function QuickReplyPicker({ conversation, canInsert = true, version = 0, onInsert, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({ name: '', phone: '' });
  const wrapRef = useRef(null);

  const contactName = conversation?.contact_name?.trim() ?? '';
  const contactPhone = conversation?.contact_wa_id ? `+${conversation.contact_wa_id}` : '';

  // Fresh list on open and after an admin edits the library (version bump).
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .listQuickReplies(undefined, controller.signal)
      .then((payload) => {
        if (alive) setItems(payload.items ?? []);
      })
      .catch((err) => {
        if (!alive || err?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Quick replies could not be loaded.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [version]);

  // Selecting a reply resets the variable values to this customer's data.
  useEffect(() => {
    setSelected(null);
    setValues({ name: contactName, phone: contactPhone });
  }, [conversation?.id, contactName, contactPhone]);

  // Escape closes it; a click outside closes it (same pattern as the emoji
  // picker and the chat header search).
  useEffect(() => {
    const onDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) onClose?.();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) =>
      [item.shortcut, item.title, item.category, item.message]
        .some((field) => String(field ?? '').toLowerCase().includes(term))
    );
  }, [items, search]);

  const missing = selected
    ? variablesIn(selected.message)
        .map((variable) => ({ ...variable, value: values[variable.key] ?? '' }))
        .filter((variable) => !variable.value.trim())
    : [];

  const insert = (text) => {
    if (!text) return;
    onInsert?.(text);
    onClose?.();
  };

  const insertItem = (item) => {
    const unresolved = variablesIn(item.message).filter(
      (variable) => !(variable.key === 'name' ? contactName : contactPhone)?.trim()
    );
    if (unresolved.length > 0) {
      // Ask for the missing value first — an unresolved {{name}} is never
      // handed to the composer.
      setSelected(item);
      return;
    }
    insert(fillVariables(item.message, { name: contactName, phone: contactPhone }));
  };

  return (
    <div
      className="qr-popover"
      ref={wrapRef}
      role="dialog"
      aria-label="Quick Replies"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="qr-head">
        <strong>Quick Replies</strong>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <input
        className="qr-search"
        type="search"
        autoFocus
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search quick replies..."
        aria-label="Search quick replies"
      />

      {error && <p className="composer-error">{error}</p>}
      {loading && <p className="modal-muted">Loading…</p>}

      <div className="qr-list">
        {!loading &&
          filtered.map((item) => (
            <div key={item.id} className={`qr-item${selected?.id === item.id ? ' is-selected' : ''}`}>
              <button type="button" className="qr-item-main" onClick={() => insertItem(item)}>
                <span className="qr-item-top">
                  <span className="qr-shortcut">{item.shortcut}</span>
                  <span className="qr-cat">{item.category}</span>
                </span>
                <span className="qr-item-preview">{item.message}</span>
              </button>
              <button
                type="button"
                className="ghost-button compact qr-use"
                onClick={() => insertItem(item)}
                disabled={!canInsert}
                title={canInsert ? 'Insert into the composer' : '24-hour window closed'}
              >
                Use
              </button>
            </div>
          ))}

        {!loading && !error && filtered.length === 0 && (
          <p className="modal-muted">
            {items.length === 0
              ? 'No quick replies yet. An admin can add them in Settings → Quick Replies.'
              : `Nothing matches “${search.trim()}”.`}
          </p>
        )}
      </div>

      {selected && (
        <div className="qr-compose">
          <div className="qr-compose-head">
            <span className="qr-shortcut">{selected.shortcut}</span>
            <span className="modal-muted">Preview</span>
          </div>

          {missing.map((variable) => (
            <label key={variable.key} className="field qr-var">
              <span>{variable.label}</span>
              <input
                value={values[variable.key] ?? ''}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [variable.key]: event.target.value }))
                }
                placeholder={variable.key === 'name' ? 'e.g. Ramesh' : 'e.g. 919876543210'}
                autoFocus
              />
            </label>
          ))}

          <pre className="qr-preview-text">{fillVariables(selected.message, values)}</pre>

          {!canInsert && (
            <p className="composer-hint">
              The 24-hour WhatsApp window is closed — quick replies are not Meta templates. Use the
              Template Library instead.
            </p>
          )}

          <div className="send-actions">
            <button type="button" className="ghost-button compact" onClick={() => setSelected(null)}>
              Back
            </button>
            <button
              type="button"
              className="primary-button compact"
              disabled={!canInsert || missing.length > 0}
              onClick={() => insert(fillVariables(selected.message, values))}
            >
              Insert
            </button>
          </div>
        </div>
      )}

      <p className="modal-hint">
        Inserts into the message box — edit it first, then press Send.
      </p>
    </div>
  );
}
