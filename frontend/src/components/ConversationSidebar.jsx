import { useEffect, useRef, useState } from 'react';
import ConversationListItem from './ConversationListItem.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import TagChip from './TagChip.jsx';
import { ConversationSkeleton, EmptyState } from './States.jsx';

const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
];

const STATUSES = [
  { key: '', label: 'Any status' },
  { key: 'open', label: 'Open' },
  { key: 'pending', label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

export default function ConversationSidebar({
  conversations,
  counts,
  total,
  loading,
  error,
  isAdmin,
  view,
  status,
  search,
  tags = [],
  tagFilter = [],
  selectedId,
  onViewChange,
  onStatusChange,
  onSearchChange,
  onTagFilterChange,
  onSelect,
  onRetry,
  onCreateConversation,
  onAddContact,
}) {
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagMenuRef = useRef(null);
  const isFiltered = Boolean(search || status);
  const tagFiltered = tagFilter.length > 0;

  // The menu is a popover: a click anywhere outside it closes it.
  useEffect(() => {
    if (!tagMenuOpen) return undefined;
    const onDown = (event) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(event.target)) setTagMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tagMenuOpen]);

  // §6 — multiple tags use ANY (OR) semantics, matching the backend query.
  const toggleTag = (tagId) => {
    const next = tagFilter.includes(tagId)
      ? tagFilter.filter((id) => id !== tagId)
      : [...tagFilter, tagId];
    onTagFilterChange?.(next);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-controls">
        <div className="search-box-row"><div className="search-box">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search name or number"
            aria-label="Search conversations"
          />
        </div><button type="button" className="new-chat-button" title="Start a new WhatsApp chat" onClick={() => onCreateConversation?.(search)}>＋</button></div>

        <button
          type="button"
          className="add-contact-button"
          onClick={() => onAddContact?.()}
          title="Save a customer name and mobile number"
        >
          ＋ Add contact
        </button>

        {isAdmin ? (
          <div className="view-tabs" role="tablist" aria-label="Conversation scope">
            {VIEWS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={view === option.key}
                className={`view-tab${view === option.key ? ' is-active' : ''}`}
                onClick={() => onViewChange(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="sidebar-scope-note">
            Showing only conversations assigned to you. New/unassigned chats can be assigned by an admin.
          </p>
        )}

        <div className="status-filters" role="group" aria-label="Filter by status">
          {STATUSES.map((option) => (
            <button
              key={option.key || 'any'}
              type="button"
              className={`chip${status === option.key ? ' is-active' : ''}`}
              onClick={() => onStatusChange(option.key)}
            >
              {option.label}
              {option.key && counts?.[option.key] !== undefined && (
                <span className="chip-count">{counts[option.key]}</span>
              )}
            </button>
          ))}

          {/* §5/§6 — tag filter. Combines with view, status and search; several
              selected tags mean OR. */}
          <div className="tag-filter" ref={tagMenuRef}>
            <button
              type="button"
              className={`chip${tagFiltered ? ' is-active' : ''}`}
              onClick={() => setTagMenuOpen((open) => !open)}
              aria-expanded={tagMenuOpen}
              aria-haspopup="true"
              title="Filter by customer tag"
            >
              Tags{tagFiltered ? ` (${tagFilter.length})` : ''}
              <span className="chip-caret" aria-hidden="true">▼</span>
            </button>

            {tagMenuOpen && (
              <div className="tag-filter-menu" role="menu" aria-label="Filter by tag">
                <button
                  type="button"
                  className={`tag-filter-option${tagFiltered ? '' : ' is-active'}`}
                  onClick={() => onTagFilterChange?.([])}
                  role="menuitem"
                >
                  <span className="tag-check" aria-hidden="true">{tagFiltered ? '☐' : '◉'}</span>
                  All Tags
                </button>

                {tags.map((tag) => {
                  const on = tagFilter.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={`tag-filter-option${on ? ' is-active' : ''}`}
                      onClick={() => toggleTag(tag.id)}
                      role="menuitemcheckbox"
                      aria-checked={on}
                    >
                      <span className="tag-check" aria-hidden="true">{on ? '☑' : '☐'}</span>
                      <TagChip tag={tag} size="sm" />
                    </button>
                  );
                })}

                {tags.length === 0 && <p className="modal-muted">No tags defined yet.</p>}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sidebar-list">
        {loading && conversations.length === 0 && <ConversationSkeleton />}

        {!loading && error && conversations.length === 0 && (
          <ErrorBanner message={error} onRetry={onRetry} />
        )}

        {!loading && !error && conversations.length === 0 && (
  <>
    {isFiltered && /^\+?\d{8,15}$/.test(search.trim()) && (
      <button
        type="button"
        className="new-contact-button"
        onClick={() => onCreateConversation?.(search)}
      >
        Start chat with {search.trim()}
      </button>
    )}

    <EmptyState
      icon="📭"
      title={
        tagFiltered
          ? 'No conversations found with this tag.'
          : isFiltered
            ? 'No matching conversations'
            : 'No conversations yet'
      }
      hint={
        tagFiltered
          ? 'Try another tag, or clear the tag filter to see everything.'
          : isFiltered
            ? 'Try a different search term or status filter.'
            : 'Incoming WhatsApp messages will appear here automatically.'
      }
    />
  </>
)}

        {conversations.length > 0 && (
          <>
            <ul className="conversation-list">
              {conversations.map((conversation) => (
                <ConversationListItem
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </ul>
            <p className="sidebar-total">
              Showing {conversations.length} of {total}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}