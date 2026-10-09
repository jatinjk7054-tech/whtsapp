import CustomerAvatar from './CustomerAvatar.jsx';
import StatusBadge from './StatusBadge.jsx';
import TagChip from './TagChip.jsx';
import { formatListStamp, formatWaId } from '../lib/format.js';

/** §4 — how many tags fit before the row collapses into a "+N" chip. */
const MAX_VISIBLE_TAGS = 3;

export default function ConversationListItem({ conversation, active, onSelect }) {
  const unread = conversation.unread_count ?? 0;
  const displayName = conversation.contact_name?.trim() || conversation.contact_wa_id;
  const tags = conversation.tags ?? [];
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTags = tags.length - visibleTags.length;

  return (
    <li>
      <button
        type="button"
        className={`conversation-item${active ? ' is-active' : ''}${unread > 0 ? ' has-unread' : ''}`}
        onClick={() => onSelect(conversation.id)}
        aria-current={active ? 'true' : undefined}
      >
        <CustomerAvatar name={displayName} waId={conversation.contact_wa_id} unread={unread > 0} />

        <span className="conversation-body">
          <span className="conversation-top">
            <span className="conversation-name">{displayName}</span>
            <span className="conversation-time">{formatListStamp(conversation.last_message_at)}</span>
          </span>

          <span className="conversation-bottom">
            <span className="conversation-preview">
              {conversation.last_message_preview || 'No messages yet'}
            </span>
            {unread > 0 && <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>}
          </span>

          <span className="conversation-meta">
            <span className="conversation-phone">{formatWaId(conversation.contact_wa_id)}</span>
            <StatusBadge status={conversation.status} />
            <span className="conversation-assignee">
              {conversation.assigned_staff_name
                ? `Assigned to ${conversation.assigned_staff_name}`
                : 'Unassigned'}
            </span>
          </span>

          {tags.length > 0 && (
            <span className="conversation-tags">
              {visibleTags.map((tag) => (
                <TagChip key={tag.id} tag={tag} size="sm" />
              ))}
              {hiddenTags > 0 && <span className="tag-more">+{hiddenTags}</span>}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}