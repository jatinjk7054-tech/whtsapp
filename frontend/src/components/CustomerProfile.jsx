import { useEffect, useState } from 'react';
import CustomerAvatar from './CustomerAvatar.jsx';
import TagChip from './TagChip.jsx';
import TagSelector from './TagSelector.jsx';
import { api, ApiError } from '../lib/api.js';
import { formatDateTime, formatMessageStamp, formatWaId } from '../lib/format.js';

/**
 * Customer Profile panel: DP (round avatar, click for a large preview, initials
 * fallback since WhatsApp has no customer-picture endpoint), name, number, first
 * contact date, last message, assigned agent, tags and internal notes — all from
 * GET /api/contacts/:waId/profile, which applies the same admin/agent ownership
 * rules as the conversation thread. Notes are read-only and never leave the CRM.
 *
 * Module 5: the Tags section adds/removes tags through the backend and writes
 * the response straight back into this panel, so the chips update instantly —
 * no page refresh. `onTagsChanged` lets the inbox refresh its list too.
 */
export default function CustomerProfile({ waId, allTags = [], onTagsChanged, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, profile: null });
  const [tagError, setTagError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!waId) return undefined;

    const controller = new AbortController();
    let alive = true;
    setState({ loading: true, error: null, profile: null });
    setTagError(null);

    api.getContactProfile(waId, controller.signal)
      .then((profile) => {
        if (alive) setState({ loading: false, error: null, profile });
      })
      .catch((error) => {
        if (!alive || error?.name === 'AbortError') return;
        setState({ loading: false, error: error?.message || 'Profile could not be loaded', profile: null });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [waId]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const { loading, error, profile } = state;
  const contact = profile?.contact;
  const conversation = profile?.conversation;
  const lastMessage = profile?.lastMessage;
  const displayName = contact?.name?.trim() || contact?.wa_id || waId;
  const tags = profile?.tags ?? [];

  /**
   * Module 5 — writes a fresh tag list straight into the open panel, so a chip
   * appears/disappears the instant the backend confirms it. The inbox is told
   * through onTagsChanged, which re-runs the list query (and the active tag
   * filter) without a page refresh.
   */
  const writeTags = (next) => {
    setState((prev) =>
      prev.profile
        ? {
            ...prev,
            profile: {
              ...prev.profile,
              tags: next,
              contact: { ...prev.profile.contact, tags: next.map((tag) => tag.name) },
            },
          }
        : prev
    );
    onTagsChanged?.();
  };

  const removeTag = async (tagId) => {
    if (busy) return;
    setBusy(true);
    setTagError(null);
    try {
      const result = await api.removeContactTag(waId, tagId);
      writeTags(result?.tags ?? []);
    } catch (err) {
      setTagError(err instanceof ApiError ? err.message : 'Tag could not be removed');
    } finally {
      setBusy(false);
    }
  };

  /** Selector "Apply": add the ticked tags, drop the unticked ones, one pass. */
  const applyTags = async (nextIds) => {
    const currentIds = tags.map((tag) => tag.id);
    const toAdd = nextIds.filter((id) => !currentIds.includes(id));
    const toRemove = currentIds.filter((id) => !nextIds.includes(id));
    if (toAdd.length === 0 && toRemove.length === 0) return;

    setBusy(true);
    setTagError(null);
    try {
      let next = tags;
      if (toAdd.length > 0) next = (await api.addContactTags(waId, toAdd)).tags ?? [];
      for (const tagId of toRemove) {
        next = (await api.removeContactTag(waId, tagId)).tags ?? [];
      }
      writeTags(next);
    } catch (err) {
      setTagError(err instanceof ApiError ? err.message : 'Tags could not be saved');
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const createTag = async (body) => {
    const tag = await api.createTag(body);
    onTagsChanged?.();
    return tag;
  };

  return (
    <div className="template-modal-backdrop" onMouseDown={onClose}>
      <section
        className="template-modal customer-profile"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Customer profile"
      >
        <div className="template-modal-head">
          <strong>Customer profile</strong>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading && <p className="contact-hint">Loading profile…</p>}

        {!loading && error && (
          <>
            <p className="composer-error">{error}</p>
            <div className="send-actions">
              <button type="button" className="ghost-button" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {!loading && !error && contact && (
          <>
            <div className="profile-identity">
              <CustomerAvatar name={displayName} waId={contact.wa_id} size="lg" />
              <div className="profile-identity-text">
                <h3 title={displayName}>{displayName}</h3>
                <span className="profile-number" title="WhatsApp address">
                  {formatWaId(contact.wa_id)}
                </span>
              </div>
            </div>

            <dl className="profile-fields">
              <div className="profile-field">
                <dt>First contact</dt>
                <dd>{formatDateTime(contact.first_contact_at) || '—'}</dd>
              </div>

              <div className="profile-field">
                <dt>Assigned agent</dt>
                <dd>{conversation?.assigned_staff_name || 'Unassigned'}</dd>
              </div>

              <div className="profile-field">
                <dt>Last message</dt>
                <dd>
                  {lastMessage ? (
                    <span className="profile-last-message" title={lastMessage.body}>
                      <span className="profile-direction">
                        {lastMessage.direction === 'inbound' ? '←' : '→'}
                      </span>
                      {lastMessage.body}
                      <span className="profile-stamp">
                        {formatMessageStamp(lastMessage.created_at)}
                      </span>
                    </span>
                  ) : (
                    'No messages yet'
                  )}
                </dd>
              </div>

              <div className="profile-field">
                <dt>Tags</dt>
                <dd>
                  <span className="profile-tags">
                    {tags.map((tag) => (
                      <TagChip
                        key={tag.id}
                        tag={tag}
                        onRemove={busy ? undefined : () => removeTag(tag.id)}
                      />
                    ))}
                    <TagSelector
                      tags={allTags}
                      selectedIds={tags.map((tag) => tag.id)}
                      onApply={applyTags}
                      onCreateTag={createTag}
                    />
                  </span>
                  {tagError && <p className="composer-error">{tagError}</p>}
                </dd>
              </div>

              <div className="profile-field">
                <dt>Internal notes</dt>
                <dd className="profile-notes">
                  {contact.notes?.trim() ? contact.notes : '—'}
                  <span className="profile-notes-hint">Never sent to the customer.</span>
                </dd>
              </div>
            </dl>
          </>
        )}
      </section>
    </div>
  );
}
