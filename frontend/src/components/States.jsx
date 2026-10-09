export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint, icon = '💬', action }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function ConversationSkeleton({ rows = 6 }) {
  return (
    <ul className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="skeleton-row">
          <span className="skeleton skeleton-avatar" />
          <span className="skeleton-lines">
            <span className="skeleton skeleton-line w-60" />
            <span className="skeleton skeleton-line w-90" />
          </span>
        </li>
      ))}
    </ul>
  );
}