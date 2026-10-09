import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCallDuration } from '../lib/calling.js';
import { formatMessageStamp } from '../lib/format.js';

const STATUS_LABELS = {
  connected: 'Completed',
  ended: 'Completed',
  missed: 'Missed',
  failed: 'Failed',
  ringing: 'Ringing',
  connecting: 'Connecting',
  initiating: 'Calling',
};

function summarize(call) {
  const who = call.direction === 'inbound' ? 'Incoming' : 'Outgoing';
  const status = STATUS_LABELS[call.status] ?? call.status;
  return `${who} · ${status}`;
}

/**
 * Module 12 — per-conversation call history. Read-only list backed by the same
 * ownership rule as the thread; a failed request shows an inline error instead
 * of an empty list that would look like "no calls".
 */
export default function CallHistory({ conversationId, conversationName, canCall, onCall, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(
    async (signal) => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.listCalls(conversationId, signal);
        setItems(payload.items ?? []);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setError(err?.message || 'Call history could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [conversationId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="call-history-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Call history">
        <div className="modal-head">
          <h2>Call history</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="modal-subtitle">{conversationName}</p>

        <div className="call-history-actions">
          {canCall && (
            <button type="button" className="primary-button compact" onClick={onCall}>
              Call now
            </button>
          )}
          <button type="button" className="ghost-button compact" onClick={() => load()}>
            Refresh
          </button>
        </div>

        {loading && <p className="modal-muted">Loading…</p>}
        {error && <p className="call-history-error">{error}</p>}

        {!loading && !error && items.length === 0 && (
          <p className="modal-muted">No calls with this customer yet.</p>
        )}

        {items.length > 0 && (
          <ul className="call-history-list">
            {items.map((call) => (
              <li key={call.id} className={`call-history-item status-${call.status}`}>
                <span className={`call-history-icon ${call.direction}`} aria-hidden="true">
                  {call.direction === 'inbound' ? '↙' : '↗'}
                </span>
                <span className="call-history-body">
                  <span className="call-history-title">{summarize(call)}</span>
                  <span className="call-history-meta">
                    {formatMessageStamp(call.createdAt)}
                    {call.status === 'connected' || call.status === 'ended'
                      ? ` · ${formatCallDuration(call.durationSeconds)}`
                      : ''}
                  </span>
                </span>
                {(call.answererName || call.initiatorName) && (
                  <span className="call-history-agent">
                    {call.answererName || call.initiatorName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
