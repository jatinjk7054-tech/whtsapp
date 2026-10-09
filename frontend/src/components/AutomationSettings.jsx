import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import ErrorBanner from './ErrorBanner.jsx';

/**
 * Module 9 — Advanced WhatsApp Automation (Admin only).
 *
 * Two independent engines live here:
 *   1. Keyword-based automatic replies — the rules on the "Keyword rules" tab.
 *   2. The Module 6 Away Message, configured in Settings, which also feeds the
 *      shared automation log.
 *
 * Nothing on this screen assigns a conversation to an agent: ownership stays
 * exactly as it is everywhere else (manual claim / manual assign). The backend
 * rejects any non-admin caller with 403, so hiding the button is only cosmetic.
 */

const MATCH_TYPES = [
  { value: 'contains', label: 'Contains' },
  { value: 'exact', label: 'Exactly matches' },
  { value: 'starts_with', label: 'Starts with' },
  { value: 'ends_with', label: 'Ends with' },
  { value: 'whole_word', label: 'Contains whole word' },
];

const emptyRule = {
  name: '',
  keyword: '',
  matchType: 'contains',
  replyText: '',
  enabled: true,
  tagId: '',
  priority: 0,
  cooldownSeconds: 0,
  templateName: '',
  templateLanguage: '',
};

const ACTION_LABELS = { keyword_reply: 'Keyword reply', away_message: 'Away message' };
const RESULT_CLASS = {
  sent: 'log-sent',
  failed: 'log-failed',
  blocked: 'log-blocked',
  skipped: 'log-skipped',
  processing: 'log-processing',
};

function ruleToForm(rule) {
  return {
    name: rule.name ?? '',
    keyword: rule.keyword ?? '',
    matchType: rule.match_type ?? 'contains',
    replyText: rule.reply_text ?? '',
    enabled: Boolean(rule.enabled),
    tagId: rule.tag_id ?? '',
    priority: rule.priority ?? 0,
    cooldownSeconds: rule.cooldown_seconds ?? 0,
    templateName: rule.template_name ?? '',
    templateLanguage: rule.template_language ?? '',
  };
}

function formToBody(form) {
  return {
    name: form.name.trim(),
    keyword: form.keyword.trim(),
    matchType: form.matchType,
    replyText: form.replyText.trim(),
    enabled: Boolean(form.enabled),
    tagId: form.tagId === '' ? null : Number(form.tagId),
    priority: Number(form.priority) || 0,
    cooldownSeconds: Number(form.cooldownSeconds) || 0,
    templateName: form.templateName.trim() || null,
    templateLanguage: form.templateLanguage.trim() || null,
  };
}

function SettingsBanner({ onChanged }) {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const payload = await api.getAutomationSettings();
      setSettings(payload.settings);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Automation settings could not be loaded.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (patch) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await api.saveAutomationSettings(patch);
      setSettings(payload.settings);
      setNotice('Automation settings saved.');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Automation settings could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : <p className="modal-muted">Loading settings…</p>;
  }

  return (
    <div className="automation-settings">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {notice && <p className="modal-hint" role="status">{notice}</p>}

      <label className="away-enable">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={saving}
          onChange={(event) => save({ enabled: event.target.checked })}
        />
        <span>Enable keyword-based automatic replies</span>
        <span className="modal-hint">
          When off, no keyword rule ever sends a message. The Away Message keeps its own switch in Settings.
        </span>
      </label>

      <label className="away-enable">
        <input
          type="checkbox"
          checked={settings.sendAwayAndKeyword}
          disabled={saving}
          onChange={(event) => save({ sendAwayAndKeyword: event.target.checked })}
        />
        <span>Also send a keyword reply when an Away Message was just sent</span>
        <span className="modal-hint">
          Off by default, so a customer never receives two automated replies for the same message.
        </span>
      </label>
    </div>
  );
}

function RulesTab() {
  const [items, setItems] = useState([]);
  const [tags, setTags] = useState([]);
  const [form, setForm] = useState(emptyRule);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rules, tagList] = await Promise.all([api.listAutomationRules(), api.listTags()]);
      setItems(rules.items ?? []);
      setTags(tagList.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Automation rules could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const startEdit = (item) => {
    setEditingId(item.id);
    setForm(ruleToForm(item));
    setError(null);
    setNotice(null);
    setTestResult(null);
  };

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyRule);
    setError(null);
    setTestResult(null);
  };

  const validate = () => {
    if (!form.name.trim()) return 'Rule name is required.';
    if (!form.keyword.trim()) return 'Keyword is required.';
    if (!form.replyText.trim()) return 'Reply text is required.';
    const hasName = Boolean(form.templateName.trim());
    const hasLanguage = Boolean(form.templateLanguage.trim());
    if (hasName !== hasLanguage) return 'Template name and language must be provided together.';
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
    try {
      const wasEditing = Boolean(editingId);
      if (editingId) await api.updateAutomationRule(editingId, formToBody(form));
      else await api.createAutomationRule(formToBody(form));
      await load();
      resetForm();
      setNotice(wasEditing ? 'Rule updated.' : 'Rule created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rule could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete rule "${item.name}"?`)) return;
    setError(null);
    setNotice(null);
    try {
      await api.deleteAutomationRule(item.id);
      if (editingId === item.id) resetForm();
      await load();
      setNotice(`Deleted "${item.name}".`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rule could not be deleted.');
    }
  };

  const runTest = async () => {
    if (!testText.trim()) {
      setError('Type a customer message to test against the rules.');
      return;
    }
    setError(null);
    setTestResult(null);
    try {
      const result = await api.testAutomationRule({ text: testText.trim() });
      setTestResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The simulation failed.');
    }
  };

  return (
    <div className="staff-manager-grid automation-grid">
      <div className="staff-list-panel">
        <div className="modal-section-title">Keyword rules</div>
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {notice && <p className="modal-hint" role="status">{notice}</p>}

        <div className="automation-test">
          <span className="modal-hint">Test a customer message (no WhatsApp message is sent):</span>
          <div className="automation-test-row">
            <input
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
              placeholder="e.g. I want to donate"
              maxLength={500}
            />
            <button type="button" className="ghost-button compact" onClick={runTest}>
              Test
            </button>
          </div>
          {testResult && (
            <p className="modal-hint" role="status">
              {testResult.matched ? (
                <>
                  Matched <strong>{testResult.rule.name}</strong> · {testResult.replyText}
                </>
              ) : (
                'No rule matched this message.'
              )}
            </p>
          )}
        </div>

        {loading ? (
          <p className="modal-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="modal-muted">No rules yet. Create the first one on the right.</p>
        ) : (
          <div className="staff-account-list">
            {items.map((item) => (
              <div
                key={item.id}
                className={`staff-account${editingId === item.id ? ' is-selected' : ''}`}
              >
                <div className="staff-account-main">
                  <strong>
                    {item.name}{' '}
                    <span className={`automation-status ${item.enabled ? 'is-on' : ''}`}>
                      {item.enabled ? 'On' : 'Off'}
                    </span>
                  </strong>
                  <span className="qr-shortcut">
                    {MATCH_TYPES.find((type) => type.value === item.match_type)?.label ?? item.match_type}: {item.keyword}
                  </span>
                  <small className="qr-preview">{item.reply_text}</small>
                  <small>
                    Priority {item.priority}
                    {item.cooldown_seconds ? ` · cooldown ${item.cooldown_seconds}s` : ''}
                    {item.tag_name ? ` · tag ${item.tag_name}` : ''}
                    {item.template_name ? ` · template ${item.template_name}` : ''}
                  </small>
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
        <div className="modal-section-title">{editingId ? 'Edit Rule' : 'Add Rule'}</div>

        <label className="field">
          <span>Name</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Donation enquiry"
            maxLength={80}
            required
          />
        </label>

        <label className="field">
          <span>Keyword</span>
          <input
            value={form.keyword}
            onChange={(event) => setForm({ ...form, keyword: event.target.value })}
            placeholder="donate"
            maxLength={200}
            required
          />
        </label>

        <label className="field">
          <span>Match type</span>
          <select
            value={form.matchType}
            onChange={(event) => setForm({ ...form, matchType: event.target.value })}
          >
            {MATCH_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
          <span className="modal-hint">Matching is always case-insensitive.</span>
        </label>

        <label className="field">
          <span>Reply text</span>
          <textarea
            value={form.replyText}
            onChange={(event) => setForm({ ...form, replyText: event.target.value })}
            rows={4}
            maxLength={4000}
            placeholder="Thank you! Here is how you can donate…"
            required
          />
        </label>

        <div className="automation-row">
          <label className="field">
            <span>Priority</span>
            <input
              type="number"
              min="0"
              max="1000"
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: event.target.value })}
            />
            <span className="modal-hint">Higher wins.</span>
          </label>

          <label className="field">
            <span>Cooldown (seconds)</span>
            <input
              type="number"
              min="0"
              max="86400"
              value={form.cooldownSeconds}
              onChange={(event) => setForm({ ...form, cooldownSeconds: event.target.value })}
            />
            <span className="modal-hint">0 = every message.</span>
          </label>
        </div>

        <label className="field">
          <span>Apply tag (optional)</span>
          <select
            value={form.tagId}
            onChange={(event) => setForm({ ...form, tagId: event.target.value })}
          >
            <option value="">No tag</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="automation-template">
          <legend>Outside the 24-hour window (optional)</legend>
          <p className="modal-hint">
            Free-form replies are not allowed outside the 24-hour window. Set an approved template to
            fall back to it; without one the attempt is blocked and logged.
          </p>
          <label className="field">
            <span>Template name</span>
            <input
              value={form.templateName}
              onChange={(event) => setForm({ ...form, templateName: event.target.value })}
              placeholder="donation_followup"
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>Template language</span>
            <input
              value={form.templateLanguage}
              onChange={(event) => setForm({ ...form, templateLanguage: event.target.value })}
              placeholder="en_US"
              maxLength={20}
            />
          </label>
        </fieldset>

        <label className="away-enable">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />
          <span>Rule enabled</span>
        </label>

        <div className="form-actions">
          {editingId && (
            <button type="button" className="ghost-button" onClick={resetForm}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </form>
    </div>
  );
}

function LogsTab() {
  const [filters, setFilters] = useState({ from: '', to: '', action: '', result: '' });
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.listAutomationLogs({
        from: filters.from || undefined,
        to: filters.to || undefined,
        action: filters.action || undefined,
        result: filters.result || undefined,
        limit: 100,
      });
      setItems(payload.items ?? []);
      setTotal(payload.total ?? 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Automation logs could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="automation-logs">
      <div className="automation-filters">
        <label className="field">
          <span>From</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
          />
        </label>
        <label className="field">
          <span>To</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Action</span>
          <select
            value={filters.action}
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
          >
            <option value="">All</option>
            <option value="keyword_reply">Keyword reply</option>
            <option value="away_message">Away message</option>
          </select>
        </label>
        <label className="field">
          <span>Result</span>
          <select
            value={filters.result}
            onChange={(event) => setFilters({ ...filters, result: event.target.value })}
          >
            <option value="">All</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="blocked">Blocked</option>
            <option value="skipped">Skipped</option>
          </select>
        </label>
        <button type="button" className="primary-button compact" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <p className="modal-hint">{total} log entr{total === 1 ? 'y' : 'ies'} (newest first, latest 100 shown).</p>

      {loading && items.length === 0 ? (
        <p className="modal-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="modal-muted">No automation activity for this filter yet.</p>
      ) : (
        <div className="automation-log-table">
          <div className="automation-log-head">
            <span>When</span>
            <span>Action</span>
            <span>Result</span>
            <span>Customer</span>
            <span>Rule / detail</span>
          </div>
          {items.map((entry) => (
            <div key={entry.id} className="automation-log-row">
              <span>{formatDateTime(entry.created_at)}</span>
              <span>{ACTION_LABELS[entry.action] ?? entry.action}</span>
              <span className={`automation-result ${RESULT_CLASS[entry.result] ?? ''}`}>
                {entry.result}
              </span>
              <span>{entry.contact_name || entry.contact_wa_id || '—'}</span>
              <span>
                {entry.rule_name ? <strong>{entry.rule_name}</strong> : null}
                {entry.detail ? `${entry.rule_name ? ' · ' : ''}${entry.detail}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AutomationSettings({ onClose }) {
  const [tab, setTab] = useState('rules');

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
        className="staff-modal automation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="automation-title">Automation</h2>
            <p>Keyword replies, the Away Message log and the 24-hour window — Admin only.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <SettingsBanner />

        <div className="view-tabs settings-tabs" role="tablist" aria-label="Automation sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rules'}
            className={`view-tab${tab === 'rules' ? ' is-active' : ''}`}
            onClick={() => setTab('rules')}
          >
            Keyword rules
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'logs'}
            className={`view-tab${tab === 'logs' ? ' is-active' : ''}`}
            onClick={() => setTab('logs')}
          >
            Logs
          </button>
        </div>

        {tab === 'rules' ? <RulesTab /> : <LogsTab />}
      </section>
    </div>
  );
}
