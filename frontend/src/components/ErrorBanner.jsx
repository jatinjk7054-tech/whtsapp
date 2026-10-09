export default function ErrorBanner({ message, onRetry, onDismiss }) {
  if (!message) return null;

  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-text">{message}</span>
      <span className="error-banner-actions">
        {onRetry && (
          <button type="button" className="link-button" onClick={onRetry}>
            Retry
          </button>
        )}
        {onDismiss && (
          <button type="button" className="link-button" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </span>
    </div>
  );
}