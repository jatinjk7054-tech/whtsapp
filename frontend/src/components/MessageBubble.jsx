import { useEffect, useRef, useState } from 'react';
import { api, fetchMediaObjectUrl } from '../lib/api.js';
import { formatMessageStamp, MESSAGE_TYPE_LABELS } from '../lib/format.js';

function Attachment({ mediaUrl, type, onOpen }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mediaUrl) return undefined;

    const controller = new AbortController();
    let created = null;

    fetchMediaObjectUrl(mediaUrl, controller.signal)
      .then((url) => {
        created = url;
        setObjectUrl(url);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') setFailed(true);
      });

    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [mediaUrl]);

  const label = MESSAGE_TYPE_LABELS[type] ?? 'Attachment';

  if (!mediaUrl) {
    return <div className="bubble-attachment is-missing">{label}</div>;
  }

  if (failed) {
    return <div className="bubble-attachment is-missing">{label} · unavailable</div>;
  }

  if (!objectUrl) {
    return <div className="bubble-attachment is-loading">{label} · loading…</div>;
  }

  if (type === 'image' || type === 'sticker') {
    return (
      <img
        className="bubble-image"
        src={objectUrl}
        alt={label}
        loading="lazy"
        onClick={() => onOpen?.(objectUrl)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen?.(objectUrl);
          }
        }}
      />
    );
  }

  if (type === 'video') {
    return <video className="bubble-video" src={objectUrl} controls playsInline preload="metadata" />;
  }

  if (type === 'audio') {
    return <audio className="bubble-audio" src={objectUrl} controls preload="metadata" />;
  }

  return (
    <a className="bubble-attachment" href={objectUrl} target="_blank" rel="noreferrer">
      {label} · open or download
    </a>
  );
}

/** `[Template] navratri` -> `navratri` */
function templateNameFrom(body) {
  const match = /^\[Template\]\s*(.+)$/i.exec(String(body ?? '').trim());
  return match ? match[1].trim() : null;
}

function buttonsOf(definition) {
  const buttons = [];
  const container = definition?.components?.find((c) => c.type === 'BUTTONS');
  for (const button of container?.buttons ?? []) {
    buttons.push({
      kind: String(button.type ?? '').toUpperCase(),
      label: button.text ?? '',
      url: button.url ?? null,
    });
  }
  for (const component of definition?.components ?? []) {
    if (component.type !== 'BUTTON') continue;
    const parameter = (component.parameters ?? []).find((p) => p?.url) ?? {};
    buttons.push({
      kind: String(component.sub_type ?? '').toUpperCase(),
      label: parameter.text ?? component.text ?? '',
      url: parameter.url ?? component.url ?? null,
    });
  }
  return buttons;
}

/**
 * What to show for a sent template. Prefer what was actually stored with the
 * message (variables already filled in, exact header media, the button values
 * that were typed) and only fall back to the approved definition for older rows
 * that only recorded `[Template] <name>`.
 */
function templateParts(message, definition) {
  const params = message.template_params ?? {};
  const components = definition?.components ?? [];
  const header = components.find((c) => c.type === 'HEADER');
  const body = components.find((c) => c.type === 'BODY');
  const footer = components.find((c) => c.type === 'FOOTER');
  const format = String(header?.format ?? '').toUpperCase();

  const storedBody = String(message.body ?? '');
  const bodyIsPlaceholder = !storedBody || /^\[Template\]/i.test(storedBody);

  const buttonParams = new Map(
    (params.buttonParams ?? []).map((entry) => [Number(entry.index), String(entry.value ?? '')])
  );

  return {
    name: message.template_name ?? templateNameFrom(message.body) ?? definition?.name ?? '',
    language: message.template_language ?? definition?.language ?? '',
    headerType: params.header?.type ?? (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format) ? format.toLowerCase() : null),
    headerUrl: params.header?.url ?? header?.example?.header_handle?.[0] ?? null,
    headerText: params.headerText ?? (format === 'TEXT' ? header?.text ?? '' : ''),
    bodyText: bodyIsPlaceholder ? body?.text ?? '' : storedBody,
    footer: footer?.text ?? '',
    buttons: buttonsOf(definition).map((button, index) => ({
      ...button,
      url: button.url
        ? button.url.replace(/\{\{\s*[^}]+?\s*\}\}/g, () => buttonParams.get(index) ?? '{{…}}')
        : null,
    })),
  };
}

let templateLoad = null;

/** Fetches the approved template list once and resolves a definition by name. */
function useTemplateDefinition(message) {
  const name = message?.template_name ?? templateNameFrom(message?.body);
  const [definition, setDefinition] = useState(null);

  useEffect(() => {
    if (!name) {
      setDefinition(null);
      return undefined;
    }

    let alive = true;

    templateLoad ??= api
      .listTemplates()
      .then((result) => result?.items ?? [])
      .catch(() => {
        templateLoad = null;
        return [];
      });

    templateLoad.then((items) => {
      if (alive) setDefinition(items.find((t) => t.name === name) ?? null);
    });

    return () => {
      alive = false;
    };
  }, [name]);

  return name ? definition : null;
}

const TICKS = {
  pending: '🕘',
  queued: '🕘',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  failed: '⚠',
};

/** Types the backend's forwardMessage() is willing to re-send (text + media). */
const FORWARDABLE_TYPES = new Set(['text', 'image', 'video', 'document', 'audio']);

export default function MessageBubble({
  message,
  contactName,
  onReply,
  onForward,
  onJumpToMessage,
  onRetryMessage,
}) {
  const isOutbound = message.direction === 'outbound';
  const isFailed = message.status === 'failed';
  const hasMedia = Boolean(message.media_url);
  const isTemplateMessage = message.type === 'template';
  const definition = useTemplateDefinition(message);
  // Render from the stored send (name/params) even before the definition loads,
  // so template bubbles never flash their raw `[Template] …` fallback.
  const parts =
    isTemplateMessage && (definition || message.template_name)
      ? templateParts(message, definition)
      : null;
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef(null);
  const copiedTimerRef = useRef(null);

  const isTypePlaceholder = message.body === `[${message.type}]`;
  const showBody = Boolean(message.body) && !(hasMedia && isTypePlaceholder);

  useEffect(() => () => {
    if (lightboxUrl) URL.revokeObjectURL(lightboxUrl);
  }, [lightboxUrl]);

  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  // Click-away / Escape close for the bubble context menu.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const copyText = async () => {
    setMenuOpen(false);
    const text = String(message.body ?? '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers without the async clipboard API.
      try {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      } catch {
        return; // clipboard unavailable (insecure context) — do not fake success
      }
    }
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  // Quoted-message preview: sender name, a media kind tag when relevant, and
  // the content (or its kind label for media). Click jumps to the original.
  const quoteSender = message.quoted_direction === 'inbound'
    ? (contactName || 'Customer')
    : (message.quoted_staff_name || 'You');
  const quoteKind = message.quoted_type && message.quoted_type !== 'text'
    ? (MESSAGE_TYPE_LABELS[message.quoted_type] ?? message.quoted_type)
    : null;
  const quoteRaw = message.quoted_body ? String(message.quoted_body) : '';
  const quoteIsPlaceholder = message.quoted_type && quoteRaw === `[${message.quoted_type}]`;
  const quoteText = quoteRaw && !quoteIsPlaceholder ? quoteRaw : (quoteKind ?? 'Message');

  return (
    <div
      className={`bubble-row ${isOutbound ? 'is-outbound' : 'is-inbound'}${hasMedia ? ' has-media' : ''}`}
      data-message-id={message.id}
    >
      <div className={`bubble${isFailed ? ' is-failed' : ''}${hasMedia ? ' has-media' : ''}`}>
        {message.reply_to_id && (
          <button
            type="button"
            className="bubble-quote"
            onClick={() => onJumpToMessage?.(message.reply_to_id)}
            title="Go to the quoted message"
          >
            <span className="bubble-quote-head">
              <span className="bubble-quote-name">{quoteSender}</span>
              {quoteKind && <span className="bubble-quote-kind">{quoteKind}</span>}
            </span>
            <span className="bubble-quote-text">{quoteText}</span>
          </button>
        )}

        <div className="bubble-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="bubble-menu-button"
            aria-label="Message actions"
            title="Message actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="bubble-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onReply?.(message);
                }}
              >
                ↩ Reply
              </button>
              {message.type === 'text' && message.body && (
                <button type="button" role="menuitem" onClick={copyText}>
                  ⧉ Copy
                </button>
              )}
              {FORWARDABLE_TYPES.has(message.type) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onForward?.(message);
                  }}
                >
                  ↪ Forward
                </button>
              )}
            </div>
          )}
        </div>

        {hasMedia && (
          <Attachment
            mediaUrl={message.media_url}
            type={parts?.headerType || message.type}
            onOpen={setLightboxUrl}
          />
        )}

        {parts ? (
          <>
            {parts.headerUrl && !hasMedia && (
              <img
                className="bubble-image"
                src={parts.headerUrl}
                alt=""
                loading="lazy"
                onError={(event) => { event.currentTarget.style.display = 'none'; }}
              />
            )}
            {parts.headerText && <p className="bubble-text bubble-header-text">{parts.headerText}</p>}
            {parts.bodyText && <p className="bubble-text">{parts.bodyText}</p>}
            {parts.footer && <div className="bubble-footer">{parts.footer}</div>}
            {parts.buttons.length > 0 && (
              <div className="bubble-template-buttons">
                {parts.buttons.map((button, index) => (
                  <span className="bubble-template-button" key={`${button.label}-${index}`}>
                    {button.kind === 'PHONE_NUMBER' ? '📞 ' : ''}
                    {button.label || button.url || '…'}
                  </span>
                ))}
              </div>
            )}
            <span className="bubble-template-tag">
              📋 {parts.name}
              {parts.language && ` · ${parts.language}`}
            </span>
          </>
        ) : (
          showBody && <p className="bubble-text">{message.body}</p>
        )}

        {isFailed && (
          <div className="bubble-failed">
            <p className="bubble-error">
              Not delivered{message.error_code ? ` (code ${message.error_code})` : ''}
              {message.error_detail ? `: ${message.error_detail}` : ''}
            </p>
            {onRetryMessage && typeof message.id === 'number' && (
              <button
                type="button"
                className="bubble-retry"
                onClick={() => onRetryMessage(message)}
              >
                ↻ Retry
              </button>
            )}
          </div>
        )}

        <span className="bubble-meta">
          {message.is_forwarded && <span className="bubble-forwarded">Forwarded</span>}
          {isOutbound && message.sent_by_staff_name && (
            <span className="bubble-author">{message.sent_by_staff_name}</span>
          )}
          <time dateTime={message.created_at}>{formatMessageStamp(message.created_at)}</time>
          {isOutbound && <span className={`bubble-ticks status-${message.status}`}>{TICKS[message.status] ?? ''}</span>}
        </span>

        {copied && (
          <span className="bubble-toast" role="status">
            Message copied
          </span>
        )}
      </div>
      {lightboxUrl && (
        <div className="media-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" />
          <button type="button" className="media-lightbox-close" onClick={() => setLightboxUrl(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}