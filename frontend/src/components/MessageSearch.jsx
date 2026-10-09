import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatMessageStamp, MESSAGE_TYPE_LABELS } from '../lib/format.js';

/** Wraps every case-insensitive occurrence of `term` in <mark> for highlighting. */
function highlight(text, term) {
  const source = String(text ?? '');
  const needle = term.trim().toLowerCase();
  if (!needle) return source;

  const parts = [];
  const lower = source.toLowerCase();
  let cursor = 0;
  let key = 0;
  for (;;) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) {
      parts.push(source.slice(cursor));
      break;
    }
    if (index > cursor) parts.push(source.slice(cursor, index));
    parts.push(<mark key={key++}>{source.slice(index, index + needle.length)}</mark>);
    cursor = index + needle.length;
  }
  return parts;
}

function snippetFor(item) {
  if (item.body && item.body !== `[${item.type}]`) return item.body;
  return MESSAGE_TYPE_LABELS[item.type] ?? item.type ?? 'Message';
}

export default function MessageSearch({ onOpenResult, onClose }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null); // null = no search run yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const requestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced server-side search. The backend scopes results to the caller
  // (agent -> own conversations, admin -> all) and always returns a LIMITed
  // page, so nothing close to the full history ever reaches the browser.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      requestRef.current += 1;
      setItems(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    const requestId = ++requestRef.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.searchMessages(term, controller.signal);
        if (requestRef.current === requestId) setItems(payload.items ?? []);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (requestRef.current === requestId) setError(err?.message ?? 'Search failed');
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div className="search-panel" role="dialog" aria-label="Search messages">
      <div className="search-panel-head">
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose?.();
          }}
          placeholder="Search messages, names or numbers…"
          aria-label="Search messages"
        />
        <button type="button" onClick={onClose} aria-label="Close search">
          ×
        </button>
      </div>

      {error && <p className="composer-error">{error}</p>}
      {loading && <p className="search-status">Searching…</p>}

      {!loading && items !== null && items.length === 0 && (
        <p className="search-status">No messages match “{query.trim()}”.</p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="search-results">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="search-result"
                onClick={() => onOpenResult?.(item.conversation_id, item.id)}
              >
                <span className="search-result-top">
                  <strong>{item.contact_name?.trim() || item.contact_wa_id}</strong>
                  <time dateTime={item.created_at}>{formatMessageStamp(item.created_at)}</time>
                </span>
                <span className="search-result-snippet">{highlight(snippetFor(item), query)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {items === null && !loading && !error && (
        <p className="search-status">Type at least 2 characters to search this inbox.</p>
      )}
    </div>
  );
}
