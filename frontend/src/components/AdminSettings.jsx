import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import ErrorBanner from './ErrorBanner.jsx';

/**
 * Module 6 — Admin Settings: the global Away Message and the Quick Reply
 * library. Both tabs are Admin-only (the backend refuses agents with 403 even
 * if this dialog is opened by hand), and neither touches anything Meta-side:
 * [Test Away Message] is a pure simulation and quick replies are only ever
 * inserted into the composer for an agent to send themselves.
 */

const DAY_ROWS = [
  { day: 1, label: 'Monday', short: 'Mon' },
  { day: 2, label: 'Tuesday', short: 'Tue' },
  { day: 3, label: 'Wednesday', short: 'Wed' },
  { day: 4, label: 'Thursday', short: 'Thu' },
  { day: 5, label: 'Friday', short: 'Fri' },
  { day: 6, label: 'Saturday', short: 'Sat' },
  { day: 0, label: 'Sunday', short: 'Sun' },
];

const DEFAULT_DAY = { enabled: false, from: '09:00', to: '18:00' };

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
];

function daysMapFrom(schedule) {
  const days = {};
  for (const row of DAY_ROWS) days[row.day] = { ...DEFAULT_DAY };
  for (const entry of schedule ?? []) {
    if (entry && days[entry.day]) {
      days[entry.day] = {
        enabled: Boolean(entry.enabled),
        from: entry.from || DEFAULT_DAY.from,
        to: entry.to || DEFAULT_DAY.to,
      };
    }
  }
  return days;
}

function scheduleSummary(days, enabled) {
  if (!enabled) return 'Off — customers get no automatic reply';
  return DAY_ROWS.map((row) => {
    const entry = days[row.day];
    return `${row.short} ${entry.enabled ? `${entry.from}–${entry.to}` : 'off'}`;
  }).join(' · ');
}

function AwayTab({ onSaved }) {
  const [form, setForm] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [testResult, setTestResult] = useState(null);
  // Module 9: public holidays / closed days.
  const [holidayDraft, setHolidayDraft] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.getAwaySettings();
      const settings = payload.settings;
      setForm({
        enabled: settings.enabled,
        message: settings.message,
        timezone: settings.timezone,
        days: daysMapFrom(settings.schedule),
        holidays: settings.holidays ?? [],
      });
      setEvaluation(payload.evaluation);
      setUpdatedAt(settings.updated_at);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Away Message settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const patch = (next) => setForm((prev) => ({ ...prev, ...next }));

  const patchDay = (day, next) =>
    setForm((prev) => ({ ...prev, days: { ...prev.days, [day]: { ...prev.days[day], ...next } } }));

  const bodyOf = () => ({
    enabled: form.enabled,
    message: form.message.trim(),
    timezone: form.timezone.trim(),
    schedule: DAY_ROWS.map((row) => ({ day: row.day, ...form.days[row.day] })),
    holidays: [...(form.holidays ?? [])].sort(),
  });

  const addHoliday = () => {
    const value = holidayDraft.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      setError('Pick a valid holiday date (YYYY-MM-DD).');
      return;
    }
    setForm((prev) => ({
      ...prev,
      holidays: [...new Set([...(prev.holidays ?? []), value])].sort(),
    }));
    setHolidayDraft('');
    setError(null);
  };

  const removeHoliday = (value) =>
    setForm((prev) => ({
      ...prev,
      holidays: (prev.holidays ?? []).filter((day) => day !== value),
    }));

  const validate = () => {
    if (!form.message.trim()) return 'The Away Message text cannot be empty.';
    if (!form.timezone.trim()) return 'Timezone is required.';
    for (const row of DAY_ROWS) {
      const entry = form.days[row.day];
      if (entry.enabled && entry.to <= entry.from) {
        return `${row.label}: office hours must finish after they start (${entry.from} → ${entry.to}).`;
      }
    }
    return null;
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const payload = await api.saveAwaySettings(bodyOf());
      setForm({
        enabled: payload.settings.enabled,
        message: payload.settings.message,
        timezone: payload.settings.timezone,
        days: daysMapFrom(payload.settings.schedule),
        holidays: payload.settings.holidays ?? [],
      });
      setEvaluation(payload.evaluation);
      setUpdatedAt(payload.settings.updated_at);
      setNotice('Away Message saved.');
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Away Message could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (saving) return;
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await api.testAwaySettings(bodyOf());
      setTestResult(payload);
      setEvaluation(payload.evaluation);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The simulation failed.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="modal-muted">Loading Away Message…</p>;
  if (!form) return null;

  return (
    <form className="away-form" onSubmit={save}>
      <div className="away-status-row">
        <span className={`away-status ${form.enabled ? 'is-on' : ''}`}>
          {form.enabled ? '● Enabled' : '○ Disabled'}
        </span>
        <span className="away-schedule-summary" title={scheduleSummary(form.days, form.enabled)}>
          {scheduleSummary(form.days, form.enabled)}
        </span>
        <span className="away-updated">
          {updatedAt ? `Last updated ${new Date(updatedAt).toLocaleString()}` : 'Not saved yet'}
        </span>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && (
        <p className="modal-hint" role="status">
          {notice}
        </p>
      )}

      <label className="away-enable">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        <span>Enable Away Message</span>
        <span className="modal-hint">
          Sent automatically to customer messages received outside the office hours below.
        </span>
      </label>

      <label className="field">
        <span>Message</span>
        <textarea
          value={form.message}
          onChange={(event) => patch({ message: event.target.value })}
          rows={4}
          maxLength={4000}
          placeholder="Thank you for contacting Being Sevak Charitable Trust."
        />
      </label>

      <fieldset className="away-days">
        <legend>Office hours</legend>
        {DAY_ROWS.map((row) => {
          const entry = form.days[row.day];
          return (
            <div key={row.day} className={`away-day${entry.enabled ? ' is-on' : ''}`}>
              <label className="away-day-toggle">
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  onChange={(event) => patchDay(row.day, { enabled: event.target.checked })}
                />
                <span>{row.label}</span>
              </label>
              <label className="away-day-time">
                <span>From</span>
                <input
                  type="time"
                  value={entry.from}
                  disabled={!entry.enabled}
                  onChange={(event) => patchDay(row.day, { from: event.target.value })}
                />
              </label>
              <label className="away-day-time">
                <span>To</span>
                <input
                  type="time"
                  value={entry.to}
                  disabled={!entry.enabled}
                  onChange={(event) => patchDay(row.day, { to: event.target.value })}
                />
              </label>
            </div>
          );
        })}
      </fieldset>

      <label className="field">
        <span>Timezone</span>
        <input
          list="away-timezones"
          value={form.timezone}
          onChange={(event) => patch({ timezone: event.target.value })}
          placeholder="Asia/Kolkata"
        />
        <datalist id="away-timezones">
          {TIMEZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <span className="modal-hint">
          Office hours are evaluated in this zone. Default: Asia/Kolkata.
        </span>
      </label>

      <fieldset className="away-holidays">
        <legend>Public holidays / closed days</legend>
        <p className="modal-hint">
          The Away Message also fires on these dates, exactly like an out-of-hours window.
        </p>
        <div className="away-holiday-add">
          <input
            type="date"
            value={holidayDraft}
            onChange={(event) => setHolidayDraft(event.target.value)}
            aria-label="Holiday date"
          />
          <button type="button" className="ghost-button compact" onClick={addHoliday}>
            Add
          </button>
        </div>
        {form.holidays?.length ? (
          <div className="away-holiday-list">
            {form.holidays.map((day) => (
              <span key={day} className="away-holiday-chip">
                {day}
                <button
                  type="button"
                  className="away-holiday-remove"
                  onClick={() => removeHoliday(day)}
                  aria-label={`Remove holiday ${day}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="modal-muted">No holidays configured.</p>
        )}
      </fieldset>

      {evaluation && (
        <p className="modal-hint">
          Right now ({evaluation.dayName} {evaluation.localTime} in {evaluation.timezone}):{' '}
          <strong>{evaluation.reason}</strong>
        </p>
      )}

      <div className="form-actions">
        <button type="button" className="ghost-button" onClick={runTest} disabled={saving}>
          Test Away Message
        </button>
        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save Away Message'}
        </button>
      </div>

      {testResult && (
        <div className="away-test-result" role="status">
          <strong>
            Simulation only — no WhatsApp message was sent.{' '}
            {testResult.evaluation.shouldSend
              ? 'A customer messaging now WOULD receive the Away Message.'
              : 'A customer messaging now would NOT receive the Away Message.'}
          </strong>
          <p className="modal-muted">{testResult.evaluation.reason}</p>
          <pre className="away-test-preview">{testResult.preview}</pre>
          <p className="modal-muted">
            Cooldown: at most one Away Message per customer every 24 hours.
          </p>
        </div>
      )}
    </form>
  );
}

const emptyQuickReply = { title: '', shortcut: '', category: 'General', message: '' };

function QuickTab({ onSaved }) {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(emptyQuickReply);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.listQuickReplies();
      setItems(payload.items ?? []);
      setCategories(payload.categories ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Quick replies could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const startEdit = (item) => {
    setEditingId(item.id);
    setForm({
      title: item.title,
      shortcut: item.shortcut,
      category: item.category,
      message: item.message,
    });
    setError(null);
    setNotice(null);
  };

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyQuickReply);
    setError(null);
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (!form.title.trim() || !form.shortcut.trim() || !form.message.trim()) {
      setError('Title, shortcut and message are all required.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const wasEditing = Boolean(editingId);
      if (editingId) await api.updateQuickReply(editingId, form);
      else await api.createQuickReply(form);
      await load();
      resetForm();
      setNotice(wasEditing ? 'Quick reply updated.' : 'Quick reply created.');
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Quick reply could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.shortcut}?`)) return;
    setError(null);
    setNotice(null);
    try {
      await api.deleteQuickReply(item.id);
      if (editingId === item.id) resetForm();
      await load();
      setNotice(`Deleted ${item.shortcut}.`);
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Quick reply could not be deleted.');
    }
  };

  return (
    <div className="staff-manager-grid quick-grid">
      <div className="staff-list-panel">
        <div className="modal-section-title">Quick replies</div>
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {notice && (
          <p className="modal-hint" role="status">
            {notice}
          </p>
        )}
        {loading ? (
          <p className="modal-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="modal-muted">No quick replies yet. Create the first one on the right.</p>
        ) : (
          <div className="staff-account-list">
            {items.map((item) => (
              <div
                key={item.id}
                className={`staff-account${editingId === item.id ? ' is-selected' : ''}`}
              >
                <div className="staff-account-main">
                  <strong>{item.title}</strong>
                  <span className="qr-shortcut">{item.shortcut}</span>
                  <small className="qr-preview">{item.message}</small>
                  <small>{item.category}</small>
                </div>
                <div className="staff-account-actions">
                  <button type="button" className="ghost-button compact" onClick={() => startEdit(item)}>
                    Edit
                  </button>
                  <button type="button" className="ghost-button compact" onClick={() => remove(item)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <form className="staff-form" onSubmit={save}>
        <div className="modal-section-title">
          {editingId ? 'Edit Quick Reply' : 'Add Quick Reply'}
        </div>

        <label className="field">
          <span>Title</span>
          <input
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder="Donation Thank You"
            maxLength={80}
            required
          />
        </label>

        <label className="field">
          <span>Shortcut</span>
          <input
            value={form.shortcut}
            onChange={(event) => setForm({ ...form, shortcut: event.target.value })}
            placeholder="/donation"
            maxLength={40}
            autoComplete="off"
            required
          />
          <span className="modal-hint">Unique, no spaces. The leading / is added for you.</span>
        </label>

        <label className="field">
          <span>Category</span>
          <select
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          >
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Message</span>
          <textarea
            value={form.message}
            onChange={(event) => setForm({ ...form, message: event.target.value })}
            rows={5}
            maxLength={4000}
            placeholder="Thank you for your support…"
            required
          />
          <span className="modal-hint">
            {'Variables: {{name}} and {{phone}} are filled in when an agent uses this reply.'}
          </span>
        </label>

        <div className="form-actions">
          {editingId && (
            <button type="button" className="ghost-button" onClick={resetForm}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function AdminSettings({ onClose, onChanged }) {
  const [tab, setTab] = useState('away');

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="staff-modal admin-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-settings-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="admin-settings-title">Settings</h2>
            <p>Away Message and Quick Replies — Admin only.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="view-tabs settings-tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'away'}
            className={`view-tab${tab === 'away' ? ' is-active' : ''}`}
            onClick={() => setTab('away')}
          >
            Away Message
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'quick'}
            className={`view-tab${tab === 'quick' ? ' is-active' : ''}`}
            onClick={() => setTab('quick')}
          >
            Quick Replies
          </button>
        </div>

        {tab === 'away' ? <AwayTab onSaved={onChanged} /> : <QuickTab onSaved={onChanged} />}
      </section>
    </div>
  );
}
