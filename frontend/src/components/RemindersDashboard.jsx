import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatDateTime, formatWaId } from '../lib/format.js';
import { Spinner } from './States.jsx';

const PAGE_SIZE = 20;
const TABS = [
  ['all', 'All', 'all'],
  ['due_today', 'Due today', 'dueToday'],
  ['overdue', 'Overdue', 'overdue'],
  ['upcoming', 'Upcoming', 'upcoming'],
  ['completed', 'Completed', 'completed'],
];

const STATUS_LABELS = {
  pending: 'Pending',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function describeError(error) {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function RemindersDashboard({
  onClose,
  onOpenConversation,
  onNewReminder,
  onEditReminder,
  refreshSignal = 0,
}) {
  const [filter, setFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const abortRef = useRef(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (!silent) setLoading(true);
      setError(null);

      try {
        const payload = await api.listReminders(
          { filter, search, limit: PAGE_SIZE, offset, timezone },
          controller.signal
        );
        setItems(payload.items ?? []);
        setCounts(payload.counts ?? {});
        setTotal(payload.total ?? 0);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setError(describeError(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [filter, search, offset, timezone]
  );

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load, refreshSignal]);

  const act = useCallback(
    async (id, action) => {
      setBusyId(id);
      try {
        await action();
        await load({ silent: true });
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal reminders-dashboard"
        role="dialog"
        aria-label="Follow-up reminders"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>Follow-up reminders</h2>
            <p className="modal-subtitle">Never let a customer follow-up slip.</p>
          </div>
          <div className="reminders-head-actions">
            <button type="button" className="primary-button" onClick={onNewReminder}>
              New reminder
            </button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        <div className="reminders-toolbar">
          <div className="reminders-tabs" role="tablist">
            {TABS.map(([value, label, countKey]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={`reminders-tab${filter === value ? ' active' : ''}`}
                onClick={() => {
                  setFilter(value);
                  setOffset(0);
                }}
              >
                {label}
                <span className="reminders-tab-count">{counts[countKey] ?? 0}</span>
              </button>
            ))}
          </div>

          <input
            type="search"
            className="reminders-search"
            value={searchInput}
            placeholder="Search customer…"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="reminders-body">
          {loading && items.length === 0 && <Spinner label="Loading reminders…" />}

          {!loading && items.length === 0 && (
            <p className="reminders-empty">No reminders here.</p>
          )}

          {items.map((reminder) => {
            const name = reminder.conversation?.contactName?.trim() || formatWaId(reminder.conversation?.contactWaId);
            const pending = reminder.status === 'pending';
            return (
              <article
                key={reminder.id}
                className={`reminder-card${reminder.isOverdue ? ' overdue' : ''} status-${reminder.status}`}
              >
                <div className="reminder-card-main">
                  <div className="reminder-card-top">
                    <button
                      type="button"
                      className="reminder-contact"
                      onClick={() => onOpenConversation(reminder.conversationId)}
                      title="Open conversation"
                    >
                      {name}
                    </button>
                    <span className={`reminder-status status-${reminder.status}`}>
                      {STATUS_LABELS[reminder.status] ?? reminder.status}
                    </span>
                    {reminder.isOverdue && <span className="reminder-overdue-chip">Overdue</span>}
                  </div>
                  <p className="reminder-title">{reminder.title}</p>
                  {reminder.notes && <p className="reminder-notes">{reminder.notes}</p>}
                  <p className="reminder-meta">
                    Due {formatDateTime(reminder.dueAt)}
                    {reminder.createdByName ? ` · by ${reminder.createdByName}` : ''}
                  </p>
                </div>

                <div className="reminder-card-actions">
                  <button
                    type="button"
                    className="ghost-button compact"
                    onClick={() => onOpenConversation(reminder.conversationId)}
                  >
                    Open
                  </button>

                  {pending && (
                    <>
                      <button
                        type="button"
                        className="ghost-button compact confirm-button"
                        disabled={busyId === reminder.id}
                        onClick={() => act(reminder.id, () => api.completeReminder(reminder.id))}
                      >
                        Complete
                      </button>
                      <button
                        type="button"
                        className="ghost-button compact"
                        disabled={busyId === reminder.id}
                        onClick={() => onEditReminder(reminder)}
                      >
                        Reschedule
                      </button>
                      <button
                        type="button"
                        className="ghost-button compact danger"
                        disabled={busyId === reminder.id}
                        onClick={() => act(reminder.id, () => api.cancelReminder(reminder.id))}
                      >
                        Cancel
                      </button>
                    </>
                  )}

                  {!pending && (
                    <button
                      type="button"
                      className="ghost-button compact"
                      disabled={busyId === reminder.id}
                      onClick={() => act(reminder.id, () => api.reopenReminder(reminder.id))}
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <footer className="reminders-footer">
          <span>
            Page {page} of {pages} · {total} reminder{total === 1 ? '' : 's'}
          </span>
          <div className="reminders-pager">
            <button
              type="button"
              className="ghost-button compact"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="ghost-button compact"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
