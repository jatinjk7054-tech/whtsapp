import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import ErrorBanner from './ErrorBanner.jsx';

const emptyForm = { name: '', email: '', password: '', role: 'agent' };

export default function StaffManager({ onClose, onChanged }) {
  const [staff, setStaff] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const editing = useMemo(() => staff.find((member) => member.id === editingId) ?? null, [staff, editingId]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.listStaff(true);
      setStaff(payload.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load agents.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
  };

  const startEdit = (member) => {
    setEditingId(member.id);
    setForm({ name: member.name, email: member.email, password: '', role: member.role });
    setError(null);
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      if (editingId) {
        const body = {
          name: form.name.trim(),
          email: form.email.trim(),
          role: form.role,
        };
        if (form.password) body.password = form.password;
        await api.updateStaff(editingId, body);
      } else {
        await api.createStaff({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          role: 'agent',
        });
      }

      await load();
      resetForm();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save agent.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (member) => {
    setError(null);
    try {
      await api.updateStaff(member.id, { isActive: !member.is_active });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update agent.');
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="staff-modal" role="dialog" aria-modal="true" aria-labelledby="staff-manager-title">
        <div className="modal-header">
          <div>
            <h2 id="staff-manager-title">Agents</h2>
            <p>Create agents and change their login email or password.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div className="staff-manager-grid">
          <div className="staff-list-panel">
            <div className="modal-section-title">Staff accounts</div>
            {loading ? (
              <p className="modal-muted">Loading…</p>
            ) : staff.length === 0 ? (
              <p className="modal-muted">No staff accounts found.</p>
            ) : (
              <div className="staff-account-list">
                {staff.map((member) => (
                  <div key={member.id} className={`staff-account${editingId === member.id ? ' is-selected' : ''}`}>
                    <div className="staff-account-main">
                      <strong>{member.name}</strong>
                      <span>{member.email}</span>
                      <small>{member.role === 'admin' ? 'Admin' : 'Agent'} · {member.is_active ? 'Active' : 'Inactive'}</small>
                    </div>
                    <div className="staff-account-actions">
                      <button type="button" className="ghost-button compact" onClick={() => startEdit(member)}>Edit</button>
                      <button type="button" className="ghost-button compact" onClick={() => toggleActive(member)}>
                        {member.is_active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form className="staff-form" onSubmit={save}>
            <div className="modal-section-title">{editing ? `Edit ${editing.name}` : 'Create Agent'}</div>

            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Agent 1" required />
            </label>

            <label className="field">
              <span>Login email</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="agent1@example.com" required />
            </label>

            <label className="field">
              <span>{editing ? 'New password (leave blank to keep current)' : 'Password'}</span>
              <input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={editing ? 'Leave blank to keep current' : 'At least 8 characters'} required={!editing} />
            </label>

            {editing && (
              <label className="field">
                <span>Role</span>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            )}

            <div className="form-actions">
              {editing && <button type="button" className="ghost-button" onClick={resetForm}>Cancel</button>}
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create Agent'}
              </button>
            </div>

            {!editing && (
              <p className="modal-hint">
                Example accounts are created in development: agent1@example.com / Agent1@12345 and agent2@example.com / Agent2@12345. Change these passwords before real use.
              </p>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}
