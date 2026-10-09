import { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import NotificationBell from './NotificationBell.jsx';

export default function TopBar({
  staff,
  counts,
  onRefresh,
  refreshing,
  onLogout,
  onManageAgents,
  onManageTags,
  onManageSettings,
  onManagePerformance,
  onManageAutomation,
  onOpenReminders,
  notifications = [],
  unread = 0,
  notifSound,
  notifBrowser,
  notifBrowserSupported,
  onToggleNotifSound,
  onToggleNotifBrowser,
  onOpenNotification,
  onMarkAllNotifRead,
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const open = counts?.open ?? 0;
  const pending = counts?.pending ?? 0;
  const resolved = counts?.resolved ?? 0;
  const closed = counts?.closed ?? 0;

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2m0 1.67c2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.25 8.24a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.18 8.18 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24m-2.6 4.2c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1s.9 2.43 1.03 2.6c.13.16 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.47-.07 1.47-.6 1.67-1.18.21-.58.21-1.08.15-1.18-.06-.1-.21-.16-.43-.28-.21-.12-1.47-.72-1.7-.8-.23-.09-.39-.13-.56.12-.16.25-.64.8-.79.97-.14.16-.29.19-.5.06-.22-.12-.92-.34-1.74-1.08-.64-.57-1.08-1.28-1.2-1.49-.13-.22-.01-.33.09-.44.1-.1.21-.25.32-.37.1-.13.14-.21.21-.35.07-.13.04-.25-.02-.35-.06-.11-.55-1.34-.76-1.83-.2-.48-.4-.42-.55-.43h-.47" />
          </svg>
        </span>
        <div className="topbar-titles">
          <strong>WhatsApp Chat</strong>
          <span>
            {open} open · {pending} pending · {resolved} resolved · {closed} closed
          </span>
        </div>
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh conversations"
          aria-label="Refresh conversations"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" strokeLinecap="round" />
            <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          type="button"
          className="ghost-button"
          onClick={onOpenReminders}
          title="Follow-up reminders"
        >
          Reminders
        </button>

        <NotificationBell
          notifications={notifications}
          unread={unread}
          soundEnabled={notifSound}
          browserEnabled={notifBrowser}
          browserSupported={notifBrowserSupported}
          onToggleSound={onToggleNotifSound}
          onToggleBrowser={onToggleNotifBrowser}
          onOpen={onOpenNotification}
          onMarkAllRead={onMarkAllNotifRead}
        />

        <span className="topbar-time" title={now.toLocaleString()}>
          {now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </span>

        <div className="topbar-user">
          <Avatar name={staff.name} seed={`staff-${staff.id}`} size="sm" />
          <div className="topbar-user-meta">
            <strong>{staff.name}</strong>
            <span className={`role-chip role-${staff.role}`}>{staff.role === 'admin' ? 'Admin' : 'Agent'}</span>
          </div>
        </div>

        {staff.role === 'admin' && (
          <button type="button" className="ghost-button" onClick={onManageAgents}>
            Agents
          </button>
        )}

        {staff.role === 'admin' && (
          <button
            type="button"
            className="ghost-button"
            onClick={onManageTags}
            title="Create, rename, recolour and delete customer tags"
          >
            Tags
          </button>
        )}

        {staff.role === 'admin' && (
          <button
            type="button"
            className="ghost-button"
            onClick={onManageSettings}
            title="Away Message and Quick Replies"
          >
            Settings
          </button>
        )}

        {staff.role === 'admin' && (
          <button
            type="button"
            className="ghost-button"
            onClick={onManagePerformance}
            title="Chats handled, messages sent and response times per agent"
          >
            Performance
          </button>
        )}

        {staff.role === 'admin' && (
          <button
            type="button"
            className="ghost-button"
            onClick={onManageAutomation}
            title="Keyword auto-replies, the 24-hour policy and automation logs"
          >
            Automation
          </button>
        )}

        <button type="button" className="ghost-button" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}