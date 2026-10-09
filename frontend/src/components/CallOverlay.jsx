import CustomerAvatar from './CustomerAvatar.jsx';
import { formatCallDuration } from '../lib/calling.js';
import { formatWaId } from '../lib/format.js';

/**
 * Module 12 — the single call surface: incoming-call prompt, active call, and
 * the short "call ended" state. It renders only real call objects handed to it
 * by useVoiceCall, so it can never show a call that is not actually happening.
 */
function statusText(phase, call) {
  switch (phase) {
    case 'ringing':
      return call.direction === 'inbound' ? 'Incoming WhatsApp call' : 'Ringing…';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'ended':
      return 'Call ended';
    case 'missed':
      return call.direction === 'inbound' ? 'Missed call' : 'Not answered';
    case 'failed':
      return 'Call failed';
    default:
      return '';
  }
}

export default function CallOverlay({
  call,
  mode,
  phase,
  elapsed,
  muted,
  error,
  onAnswer,
  onDecline,
  onEnd,
  onToggleMute,
  onOpenConversation,
}) {
  if (!call && !error) return null;

  const contact = call ?? {};
  const displayName = contact.contactName?.trim() || formatWaId(contact.contactWaId);
  const isTerminal = ['ended', 'missed', 'failed'].includes(phase);
  const isIncomingPrompt = mode === 'incoming' && !isTerminal;

  return (
    <div className="call-overlay" role="dialog" aria-modal="true" aria-label="Voice call">
      <div className={`call-card${isIncomingPrompt ? ' incoming' : ''}`}>
        <div className="call-avatar">
          <CustomerAvatar name={displayName} waId={contact.contactWaId} size="lg" />
        </div>

        <h2 className="call-name">{displayName || 'Customer'}</h2>
        <p className="call-status" aria-live="polite">
          {statusText(phase, contact)}
          {phase === 'connected' && <span className="call-timer"> · {formatCallDuration(elapsed)}</span>}
        </p>

        {contact.contactWaId && (
          <button
            type="button"
            className="call-number"
            title="Open this conversation"
            onClick={() => onOpenConversation?.(contact.conversationId)}
          >
            {formatWaId(contact.contactWaId)}
          </button>
        )}

        {error && <p className="call-error">{error}</p>}

        <div className="call-actions">
          {isIncomingPrompt ? (
            <>
              <button type="button" className="call-btn decline" onClick={onDecline} title="Decline">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
                  <path d="M21 15.5c-1.6-1.6-3.4-2.4-5-2.6-.5-.1-1 .1-1.4.5l-1 1c-2-1-3.6-2.6-4.6-4.6l1-1c.4-.4.6-.9.5-1.4C10.3 5.8 9.5 4 7.9 2.4 7.5 2 6.9 2 6.5 2.3 4.6 3.7 3.4 5.7 3.7 8c.3 2.6 1.9 5.6 4.7 8.4 2.8 2.8 5.8 4.4 8.4 4.7 2.3.3 4.3-.9 5.7-2.8.3-.4.3-1-.1-1.4z" />
                </svg>
                <span>Decline</span>
              </button>
              <button type="button" className="call-btn answer" onClick={onAnswer} title="Answer">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
                  <path d="M21 15.5c-1.6-1.6-3.4-2.4-5-2.6-.5-.1-1 .1-1.4.5l-1 1c-2-1-3.6-2.6-4.6-4.6l1-1c.4-.4.6-.9.5-1.4C10.3 5.8 9.5 4 7.9 2.4 7.5 2 6.9 2 6.5 2.3 4.6 3.7 3.4 5.7 3.7 8c.3 2.6 1.9 5.6 4.7 8.4 2.8 2.8 5.8 4.4 8.4 4.7 2.3.3 4.3-.9 5.7-2.8.3-.4.3-1-.1-1.4z" />
                </svg>
                <span>Answer</span>
              </button>
            </>
          ) : isTerminal ? (
            <button type="button" className="call-btn close" onClick={onEnd} title="Close">
              <span>Close</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`call-btn mute${muted ? ' active' : ''}`}
                onClick={onToggleMute}
                title={muted ? 'Unmute' : 'Mute'}
                disabled={phase !== 'connected'}
              >
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <button type="button" className="call-btn decline" onClick={onEnd} title="End call">
                <span>End</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
