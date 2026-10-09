import { useEffect, useRef, useState } from 'react';
import { formatMessageStamp } from '../lib/format.js';

const TYPE_LABELS = {
  new_message: 'New message',
  reminder_due: 'Reminder due',
  missed_call: 'Missed call',
};

export default function NotificationBell({
  notifications = [],
  unread = 0,
  soundEnabled,
  browserEnabled,
  browserSupported,
  onToggleSound,
  onToggleBrowser,
  onOpen,
  onMarkAllRead,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-button notif-bell"
        title="Notifications"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {unread > 0 && <span className="notif-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-panel-head">
            <strong>Notifications</strong>
            <button
              type="button"
              className="link-button"
              onClick={onMarkAllRead}
              disabled={unread === 0}
            >
              Mark all read
            </button>
          </div>

          <div className="notif-prefs">
            <label className="notif-pref">
              <input
                type="checkbox"
                checked={Boolean(soundEnabled)}
                onChange={(event) => onToggleSound(event.target.checked)}
              />
              <span>Sound alerts</span>
            </label>
            <label className="notif-pref" title={browserSupported ? '' : 'Not supported by this browser'}>
              <input
                type="checkbox"
                checked={Boolean(browserEnabled)}
                disabled={!browserSupported}
                onChange={(event) => onToggleBrowser(event.target.checked)}
              />
              <span>Desktop notifications</span>
            </label>
          </div>

          <div className="notif-list">
            {notifications.length === 0 && (
              <p className="notif-empty">You have no notifications yet.</p>
            )}

            {notifications.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`notif-item${item.isRead ? '' : ' unread'}`}
                onClick={() => {
                  setOpen(false);
                  onOpen(item);
                }}
              >
                <span className={`notif-dot type-${item.type}`} aria-hidden="true" />
                <span className="notif-item-body">
                  <span className="notif-item-title">
                    <span className="notif-type-chip">{TYPE_LABELS[item.type] ?? item.type}</span>
                    {item.title}
                  </span>
                  <span className="notif-item-text">{item.body}</span>
                  <span className="notif-item-time">{formatMessageStamp(item.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
