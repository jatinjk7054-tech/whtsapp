import { useEffect, useRef, useState } from 'react';
import CustomerAvatar from './CustomerAvatar.jsx';
import StatusBadge from './StatusBadge.jsx';
import MessageSearch from './MessageSearch.jsx';
import { formatMessageStamp, formatWaId, STATUS_LABELS } from '../lib/format.js';

export default function ChatHeader({
  conversation,
  busy,
  error,
  isAdmin,
  staffList = [],
  canCall = false,
  callingEnabled = false,
  onStartCall,
  onOpenCallHistory,
  onShowCallingSetup,
  onAssign,
  onStatusChange,
  onOpenProfile,
  onOpenSearchResult,
  onSetReminder,
  onBack,
}) {
  const displayName = conversation.contact_name?.trim() || conversation.contact_wa_id;
  const [searchOpen, setSearchOpen] = useState(false);
  const searchWrapRef = useRef(null);
  // Module 7 §12 — Resolved/Closed ask once before applying; Open/Pending are
  // cheap and apply immediately (no annoying confirmation on the hot path).
  const [confirmStatus, setConfirmStatus] = useState(null);

  // A different thread (or the same thread being reloaded) resets any pending
  // confirmation, so stale prompts never leak across customers.
  useEffect(() => setConfirmStatus(null), [conversation.id]);

  // Close the search panel when clicking anywhere outside it (including the
  // rest of the header and the message list).
  useEffect(() => {
    if (!searchOpen) return undefined;
    const onDown = (event) => {
      if (!searchWrapRef.current?.contains(event.target)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [searchOpen]);

  return (
    <header className="chat-header">
      <button type="button" className="icon-button back-button" onClick={onBack} aria-label="Back to conversations">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m14 6-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <CustomerAvatar name={displayName} waId={conversation.contact_wa_id} size="lg" />

      <div className="chat-header-identity">
        <div className="chat-header-name-row">
          <h2
            title="View customer profile"
            className="clickable-identity"
            onClick={onOpenProfile}
          >
            {displayName}
          </h2>
          {conversation.unread_count > 0 && (
            <span className="unread-badge">{conversation.unread_count} new</span>
          )}
        </div>
        <div className="chat-header-sub">
          <span className="chat-header-phone" title="WhatsApp address">
            {formatWaId(conversation.contact_wa_id)}
          </span>
          <StatusBadge status={conversation.status} />
          <span className="chat-header-stamp">
            Updated {formatMessageStamp(conversation.updated_at ?? conversation.last_message_at)}
          </span>
        </div>
      </div>

      <div className="chat-header-actions">
        <div className="chat-search-wrap" ref={searchWrapRef}>
          {searchOpen && (
            <MessageSearch
              onOpenResult={(conversationId, messageId) => {
                setSearchOpen(false);
                onOpenSearchResult?.(conversationId, messageId);
              }}
              onClose={() => setSearchOpen(false)}
            />
          )}
          <button
            type="button"
            className="icon-button"
            title="Search messages"
            aria-label="Search messages"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
            disabled={busy}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <button
          type="button"
          className="ghost-button compact profile-button"
          onClick={onOpenProfile}
          disabled={busy}
          title="Customer profile: name, number, tags, notes"
        >
          Profile
        </button>

        {/* Module 12 — voice calling. When it is not configured we show no call
            button to agents, and only an admin-facing "Setup" link, so nobody is
            ever offered a call that cannot be placed. */}
        {callingEnabled ? (
          <>
            <button
              type="button"
              className="icon-button call-button"
              onClick={onStartCall}
              disabled={busy || !canCall}
              title={canCall ? 'Start a WhatsApp voice call' : 'You cannot call this conversation'}
              aria-label="Start voice call"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15.5c-1.6-1.6-3.4-2.4-5-2.6-.5-.1-1 .1-1.4.5l-1 1c-2-1-3.6-2.6-4.6-4.6l1-1c.4-.4.6-.9.5-1.4C10.3 5.8 9.5 4 7.9 2.4 7.5 2 6.9 2 6.5 2.3 4.6 3.7 3.4 5.7 3.7 8c.3 2.6 1.9 5.6 4.7 8.4 2.8 2.8 5.8 4.4 8.4 4.7 2.3.3 4.3-.9 5.7-2.8.3-.4.3-1-.1-1.4z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="ghost-button compact"
              onClick={onOpenCallHistory}
              disabled={busy}
              title="Call history"
            >
              Calls
            </button>
          </>
        ) : (
          isAdmin && (
            <button
              type="button"
              className="ghost-button compact"
              onClick={onShowCallingSetup}
              title="WhatsApp Calling is not set up yet"
            >
              Call setup
            </button>
          )
        )}

        <button
          type="button"
          className="ghost-button compact reminder-button"
          onClick={onSetReminder}
          disabled={busy}
          title="Set a follow-up reminder for this customer"
        >
          Reminder
        </button>

        <label className="select-field">
          <span className="sr-only">Conversation status</span>
          <select
            value={conversation.status}
            disabled={busy || confirmStatus !== null}
            onChange={(event) => {
              const next = event.target.value;
              if (next === conversation.status) return;
              if (next === 'resolved' || next === 'closed') {
                setConfirmStatus(next);
                return;
              }
              onStatusChange(next);
            }}
          >
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {isAdmin ? (
          <label className="select-field" title="Assign conversation">
            <span className="sr-only">Assigned agent</span>
            <select
              value={conversation.assigned_staff_id ?? ''}
              disabled={busy}
              onChange={(event) => onAssign?.(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Unassigned</option>
              {staffList.filter((member) => member.role === 'agent').map((member) => (
                <option key={member.id} value={member.id}>{member.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="agent-label">{conversation.assigned_staff_name || 'Unassigned'}</span>
        )}
      </div>

      {confirmStatus && (
        <div className="chat-header-confirm" role="alertdialog" aria-label="Confirm status change">
          <span>Mark this conversation as {STATUS_LABELS[confirmStatus] ?? confirmStatus}?</span>
          <button
            type="button"
            className="ghost-button compact"
            onClick={() => setConfirmStatus(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ghost-button compact confirm-button"
            onClick={() => {
              onStatusChange(confirmStatus);
              setConfirmStatus(null);
            }}
          >
            {STATUS_LABELS[confirmStatus] ?? confirmStatus}
          </button>
        </div>
      )}

      {error && <p className="chat-header-error">{error}</p>}
    </header>
  );
}
