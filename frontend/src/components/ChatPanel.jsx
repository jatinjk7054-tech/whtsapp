import ChatHeader from './ChatHeader.jsx';
import MessageList from './MessageList.jsx';
import MessageComposer from './MessageComposer.jsx';
import { EmptyState } from './States.jsx';

export default function ChatPanel({
  conversation,
  messages,
  loading,
  error,
  hasMore,
  loadingOlder,
  olderError,
  busy,
  headerError,
  staff,
  isAdmin,
  staffList,
  quickRepliesVersion,
  replyTo,
  focusMessageId,
  callingEnabled,
  onStartCall,
  onOpenCallHistory,
  onShowCallingSetup,
  onLoadOlder,
  onRetry,
  onRetryOlder,
  onClaim,
  onAssign,
  onStatusChange,
  onOpenProfile,
  onOpenSearchResult,
  onSetReminder,
  onSend,
  onSendTemplate,
  onSendMedia,
  onReply,
  onCancelReply,
  onForward,
  onJumpToMessage,
  onRetryMessage,
  onFocusHandled,
  onBack,
}) {
  if (!conversation) {
    return (
      <section className="chat-panel">
        <EmptyState
          icon="💬"
          title="Select a conversation"
          hint="Pick a customer from the list to read the thread and reply over WhatsApp."
        />
      </section>
    );
  }

  // Mirrors the backend's assertSendable(): an agent must own the conversation,
  // and a closed thread cannot receive replies until it is reopened.
  const isOwner = isAdmin || conversation.assigned_staff_id === staff.id;
  const isClosed = conversation.status === 'closed';
  const canSend = isOwner && !isClosed;
  const lastInboundAt = conversation.last_inbound_at ? new Date(conversation.last_inbound_at).getTime() : 0;
  const canSendFreeText = canSend && lastInboundAt > 0 && (Date.now() - lastInboundAt) < 24 * 60 * 60 * 1000;

  const disabledHint = isClosed
    ? 'This conversation is closed. Reopen it to send a reply.'
    : !isOwner
      ? 'This conversation is assigned to another staff member.'
      : null;

  const contactName = conversation.contact_name?.trim() || conversation.contact_wa_id;
  const replySenderName = replyTo
    ? replyTo.direction === 'inbound'
      ? contactName
      : (replyTo.sent_by_staff_name || 'You')
    : null;

  // Module 12 — calling follows the same ownership rule as sending; a closed
  // thread is not callable until reopened.
  const canCall = isOwner && !isClosed;

  return (
    <section className="chat-panel">
      <ChatHeader
        conversation={conversation}
        staff={staff}
        isAdmin={isAdmin}
        staffList={staffList}
        busy={busy}
        error={headerError}
        canCall={canCall}
        callingEnabled={Boolean(callingEnabled)}
        onStartCall={() => onStartCall?.(conversation)}
        onOpenCallHistory={() => onOpenCallHistory?.(conversation)}
        onShowCallingSetup={onShowCallingSetup}
        onClaim={onClaim}
        onAssign={onAssign}
        onStatusChange={onStatusChange}
        onOpenProfile={onOpenProfile}
        onOpenSearchResult={onOpenSearchResult}
        onSetReminder={onSetReminder}
        onBack={onBack}
      />

      <MessageList
        messages={messages}
        loading={loading}
        error={error}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        olderError={olderError}
        focusMessageId={focusMessageId}
        contactName={contactName}
        onLoadOlder={onLoadOlder}
        onRetry={onRetry}
        onRetryOlder={onRetryOlder}
        onFocusHandled={onFocusHandled}
        onReply={onReply}
        onForward={onForward}
        onJumpToMessage={onJumpToMessage}
        onRetryMessage={onRetryMessage}
      />

      <MessageComposer
        canSend={canSend}
        canSendFreeText={canSendFreeText}
        disabledHint={disabledHint}
        templateWindowHint={canSend && !canSendFreeText ? 'The 24-hour WhatsApp window is closed. Only an approved Meta template can be sent.' : null}
        conversation={conversation}
        quickRepliesVersion={quickRepliesVersion}
        replyTo={replyTo}
        replySenderName={replySenderName}
        onCancelReply={onCancelReply}
        onSend={onSend}
        onSendTemplate={onSendTemplate}
        onSendMedia={onSendMedia}
      />
    </section>
  );
}