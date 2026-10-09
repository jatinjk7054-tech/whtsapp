import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatMessageStamp, formatWaId, MESSAGE_TYPE_LABELS } from '../lib/format.js';

function kindLabel(type) {
  if (type === 'text') return 'Text';
  if (type === 'template') return 'Template';
  return MESSAGE_TYPE_LABELS[type] ?? 'Message';
}

/**
 * Pick a conversation, confirm, then re-send the source message through the
 * existing outbound flow (POST /api/conversations/:id/forward). The modal owns
 * its search + confirmation state; App closes it once the forward resolves.
 */
export default function ForwardModal({ message, onForward, onClose }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const inputRef = useRef(null);
  const requestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced conversation picker, scoped server-side exactly like the inbox.
  useEffect(() => {
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    const term = query.trim();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.listConversations(
          { search: term, sort: 'recent', limit: 30, offset: 0 },
          controller.signal
        );
        if (requestRef.current === requestId) setItems(payload.items ?? []);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (requestRef.current === requestId) setError(err?.message ?? 'Could not load conversations');
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    }, term ? 300 : 0);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const confirmForward = async () => {
    if (!selected || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onForward?.(selected.id);
    } catch (err) {
      setSendError(err?.message ?? 'The message could not be forwarded');
    } finally {
      setSending(false);
    }
  };

  const previewText = message?.body && message.body !== `[${message.type}]` ? message.body : '';

  return (
    <div className="template-modal-backdrop" onMouseDown={onClose}>
      <div className="template-modal forward-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="template-modal-head">
          <strong>Forward message</strong>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="forward-preview">
          <span className="forward-preview-kind">{kindLabel(message.type)}</span>
          <span className="forward-preview-text">{previewText || kindLabel(message.type)}</span>
        </p>

        {!selected ? (
          <>
            <input
              ref={inputRef}
              className="forward-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onClose?.();
              }}
              placeholder="Search conversations…"
              aria-label="Search conversations"
            />
            {error && <p className="composer-error">{error}</p>}
            {loading && <p className="forward-status">Loading…</p>}
            {!loading && items && items.length === 0 && (
              <p className="forward-status">No conversations found.</p>
            )}
            <div className="forward-list">
              {items?.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  className="forward-item"
                  onClick={() => {
                    setSelected(conversation);
                    setSendError(null);
                  }}
                >
                  <strong>{conversation.contact_name?.trim() || conversation.contact_wa_id}</strong>
                  <span>{formatWaId(conversation.contact_wa_id)}</span>
                  <time>{formatMessageStamp(conversation.last_message_at)}</time>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="forward-confirm">
            <p>
              Send this message to{' '}
              <strong>{selected.contact_name?.trim() || selected.contact_wa_id}</strong> (
              {formatWaId(selected.contact_wa_id)})?
            </p>
            {sendError && <p className="composer-error">{sendError}</p>}
            <div className="send-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setSelected(null)}
                disabled={sending}
              >
                Back
              </button>
              <button type="button" className="send-button" onClick={confirmForward} disabled={sending}>
                {sending ? 'Sending…' : 'Forward'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
