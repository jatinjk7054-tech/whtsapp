import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { TAG_COLOR_PALETTE, normalizeHex } from '../lib/tags.js';
import ErrorBanner from './ErrorBanner.jsx';
import TagChip from './TagChip.jsx';

const emptyForm = { name: '', color: TAG_COLOR_PALETTE[7] };

/**
 * §2/§16 — admin tag management: create, rename, recolour and delete tags from
 * one dialog. Delete asks for confirmation first and reports how many customers
 * lost the tag (the backend cascades contact_tags and answers with the count).
 *
 * Only admins open this: the TopBar hides the button and the backend refuses
 * PATCH/DELETE with 403 for agents. The "+ Create New Tag" inside the customer
 * profile is the path agents use instead.
 */
export default function TagManager({ onClose, onChanged }) {
  const [tags, setTags] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const editing = tags.find((tag) => tag.id === editingId) ?? null;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.listTags();
      setTags(payload.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load tags.');
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

  const startEdit = (tag) => {
    setEditingId(tag.id);
    setForm({ name: tag.name, color: normalizeHex(tag.color) ?? tag.color });
    setError(null);
    setNotice(null);
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      if (editingId) {
        await api.updateTag(editingId, {
          name: form.name.trim(),
          color: normalizeHex(form.color) ?? undefined,
        });
      } else {
        await api.createTag({
          name: form.name.trim(),
          color: normalizeHex(form.color) ?? undefined,
        });
      }

      await load();
      resetForm();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save tag.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tag) => {
    const confirmed = window.confirm(`Delete ${tag.name} tag?`);
    if (!confirmed) return;

    setError(null);
    setNotice(null);
    try {
      const result = await api.deleteTag(tag.id);
      if (editingId === tag.id) resetForm();
      if (result?.removedAssignments > 0) {
        setNotice(
          `Deleted “${tag.name}”. Removed from ${result.removedAssignments} customer${
            result.removedAssignments === 1 ? '' : 's'
          }.`
        );
      } else {
        setNotice(`Deleted “${tag.name}”.`);
      }
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete tag.');
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="staff-modal tag-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-manager-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="tag-manager-title">Tags</h2>
            <p>Create, rename and colour the labels used to filter conversations.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {notice && (
          <p className="modal-hint" role="status">
            {notice}
          </p>
        )}

        <div className="staff-manager-grid">
          <div className="staff-list-panel">
            <div className="modal-section-title">All tags</div>
            {loading ? (
              <p className="modal-muted">Loading…</p>
            ) : tags.length === 0 ? (
              <p className="modal-muted">No tags yet. Create the first one on the right.</p>
            ) : (
              <div className="staff-account-list">
                {tags.map((tag) => (
                  <div
                    key={tag.id}
                    className={`staff-account${editingId === tag.id ? ' is-selected' : ''}`}
                  >
                    <div className="staff-account-main tag-account-main">
                      <TagChip tag={tag} />
                      <small>
                        {tag.assignment_count > 0
                          ? `Used on ${tag.assignment_count} customer${
                              tag.assignment_count === 1 ? '' : 's'
                            }`
                          : 'Not used yet'}
                      </small>
                    </div>
                    <div className="staff-account-actions">
                      <button type="button" className="ghost-button compact" onClick={() => startEdit(tag)}>
                        Edit
                      </button>
                      <button type="button" className="ghost-button compact" onClick={() => remove(tag)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <form className="staff-form" onSubmit={save}>
            <div className="modal-section-title">{editing ? `Edit ${editing.name}` : 'Create Tag'}</div>

            <label className="field">
              <span>Tag name</span>
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Volunteer"
                maxLength={40}
                autoComplete="off"
                required
              />
            </label>

            <label className="field">
              <span>Colour</span>
              <div className="tag-swatches" role="group" aria-label="Tag colour">
                {TAG_COLOR_PALETTE.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className={`tag-swatch${form.color === swatch ? ' is-active' : ''}`}
                    style={{ background: swatch }}
                    onClick={() => setForm({ ...form, color: swatch })}
                    aria-label={`Colour ${swatch}`}
                    aria-pressed={form.color === swatch}
                  />
                ))}
              </div>
            </label>

            <div className="tag-preview">
              <span>Preview</span>
              <TagChip tag={{ id: 0, name: form.name.trim() || 'Tag name', color: form.color }} />
            </div>

            <div className="form-actions">
              {editing && (
                <button type="button" className="ghost-button" onClick={resetForm}>
                  Cancel
                </button>
              )}
              <button type="submit" className="primary-button" disabled={saving || !form.name.trim()}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create Tag'}
              </button>
            </div>

            <p className="modal-hint">
              Renaming a tag updates every customer, list and filter at once. Deleting removes it
              from the customers it is on — no conversations are lost.
            </p>
          </form>
        </div>
      </section>
    </div>
  );
}
