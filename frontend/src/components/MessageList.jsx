import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import { EmptyState, Spinner } from './States.jsx';

export default function MessageList({
  messages,
  loading,
  error,
  hasMore,
  loadingOlder,
  olderError,
  onLoadOlder,
  onRetryOlder,
  onRetry,
  focusMessageId,
  onFocusHandled,
  onReply,
  onForward,
  onJumpToMessage,
  onRetryMessage,
  contactName,
}) {
  const bottomRef = useRef(null);
  const listRef = useRef(null);
  const flashTimerRef = useRef(null);
  const previousCount = useRef(messages.length);

  // Follow new activity, but only when the agent was already at the bottom -
  // otherwise opening the thread would yank them away from older history.
  useEffect(() => {
    if (messages.length === previousCount.current) return;
    previousCount.current = messages.length;

    const scroller = bottomRef.current?.closest('.messages');
    if (!scroller) return;

    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceFromBottom < 220) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // Jump-to-message (search results and quoted replies): scroll the target into
  // view and flash it. If it is not in the loaded window yet, keep paging older
  // history until it arrives, the thread is exhausted, or focus is cleared.
  useEffect(() => {
    if (!focusMessageId || loading) return undefined;

    const target = listRef.current?.querySelector(
      `[data-message-id="${CSS.escape(String(focusMessageId))}"]`
    );
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('is-flash');
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => target.classList.remove('is-flash'), 1800);
      onFocusHandled?.();
      return undefined;
    }
    if (loadingOlder) return undefined;
    if (hasMore) {
      onLoadOlder?.();
      return undefined;
    }
    // History is exhausted and the message is not here - stop rather than spin.
    onFocusHandled?.();
    return undefined;
  }, [focusMessageId, messages, loading, loadingOlder, hasMore, onLoadOlder, onFocusHandled]);

  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

  if (loading && messages.length === 0) {
    return (
      <div className="messages" ref={listRef}>
        <Spinner label="Loading conversation…" />
      </div>
    );
  }

  if (error && messages.length === 0) {
    return (
      <div className="messages" ref={listRef}>
        <ErrorBanner message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="messages" ref={listRef}>
        <EmptyState
          icon="💬"
          title="No messages in this conversation yet"
          hint="When the customer writes, their message will show up here."
        />
      </div>
    );
  }

  return (
    <div className="messages" ref={listRef}>
      <div className="messages-older">
        {olderError ? (
          <ErrorBanner message={olderError} onRetry={onRetryOlder} />
        ) : loadingOlder ? (
          <Spinner label="Loading earlier messages…" />
        ) : hasMore ? (
          <button type="button" className="ghost-button" onClick={onLoadOlder}>
            Load earlier messages
          </button>
        ) : (
          <span className="messages-thread-start">This is the beginning of the conversation</span>
        )}
      </div>

      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          contactName={contactName}
          onReply={onReply}
          onForward={onForward}
          onJumpToMessage={onJumpToMessage}
          onRetryMessage={onRetryMessage}
        />
      ))}

      <div ref={bottomRef} />
    </div>
  );
}
