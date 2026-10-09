import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatWaId } from '../lib/format.js';

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in the user's own timezone. */
function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultDue() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return toLocalInput(date);
}

function describeError(error) {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function ReminderForm({ conversation, reminder, isAdmin, onSaved, onClose }) {
  const editing = Boolean(reminder);

  const [target, setTarget] = useState(() => {
    if (conversation) {
      return { id: conversation.id, name: conversation.contact_name, waId: conversation.contact_wa_id };
    }
    if (reminder?.conversation) {
      return {
        id: reminder.conversation.id,
        name: reminder.conversation.contactName,
        waId: reminder.conversation.contactWaId,
      };
    }
    return null;
  });

  const [title, setTitle] = useState(reminder?.title ?? '');
  const [notes, setNotes] = useState(reminder?.notes ?? '');
  const [dueAt, setDueAt] = useState(() =>
    reminder?.dueAt ? toLocalInput(new Date(reminder.dueAt)) : defaultDue()
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Conversation picker (only when there is no fixed conversation).
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (target || editing) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const payload = await api.listConversations(
          { view: isAdmin ? 'all' : 'mine', search: query.trim(), limit: 8, sort: 'recent' },
          controller.signal
        );
        setResults(payload.items ?? []);
      } catch (err) {
        if (err?.name !== 'AbortError') setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, target, editing, isAdmin]);

  const targetLabel = useMemo(() => {
    if (!target) return null;
    return target.name?.trim() || formatWaId(target.waId);
  }, [target]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (!target) {
        setError('Choose the customer this reminder is for.');
        return;
      }
      if (!title.trim()) {
        setError('Give the reminder a title.');
        return;
      }

      const parsedDue = new Date(dueAt);
      if (Number.isNaN(parsedDue.getTime())) {
        setError('Choose a valid due date and time.');
        return;
      }

      setSaving(true);
      setError(null);
      try {
        const body = { title: title.trim(), notes: notes.trim(), dueAt: parsedDue.toISOString() };
        if (editing) await api.updateReminder(reminder.id, body);
        else await api.createReminder({ conversationId: target.id, ...body });

        onSaved?.();
        onClose();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setSaving(false);
      }
    },
    [target, title, notes, dueAt, editing, reminder, onSaved, onClose]
  );

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal reminder-form"
        role="dialog"
        aria-label={editing ? 'Edit reminder' : 'New reminder'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{editing ? 'Edit reminder' : 'New follow-up reminder'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <form className="reminder-form-body" onSubmit={handleSubmit}>
          {error && <p className="form-error">{error}</p>}

          {target ? (
            <div className="reminder-target">
              <span className="reminder-target-label">Customer</span>
              <strong>{targetLabel}</strong>
              {!editing && !conversation && (
                <button type="button" className="link-button" onClick={() => setTarget(null)}>
                  Change
                </button>
              )}
            </div>
          ) : (
            <div className="reminder-picker">
              <label className="reminder-field">
                <span>Customer</span>
                <input
                  type="text"
                  value={query}
                  placeholder="Search by name or number…"
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
              </label>
              <div className="reminder-picker-results">
                {searching && <p className="reminder-picker-hint">Searching…</p>}
                {!searching && results.length === 0 && (
                  <p className="reminder-picker-hint">No conversations found.</p>
                )}
                {results.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="reminder-picker-item"
                    onClick={() =>
                      setTarget({
                        id: item.id,
                        name: item.contact_name,
                        waId: item.contact_wa_id,
                      })
                    }
                  >
                    <strong>{item.contact_name?.trim() || formatWaId(item.contact_wa_id)}</strong>
                    <span>{formatWaId(item.contact_wa_id)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="reminder-field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              maxLength={200}
              placeholder="e.g. Call back about pricing"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="reminder-field">
            <span>Due</span>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>

          <label className="reminder-field">
            <span>Notes (optional)</span>
            <textarea
              value={notes}
              maxLength={2000}
              rows={3}
              placeholder="Add context for the follow-up…"
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create reminder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
