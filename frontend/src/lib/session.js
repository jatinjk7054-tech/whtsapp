const STORAGE_KEY = 'jatin.inbox.session';

/**
 * The JWT issued by POST /api/staff/login is kept in localStorage so a refresh
 * does not force a re-login. Only the token and the public staff profile the
 * API already returns are stored - no API credentials exist on the client.
 */
export function loadSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.staff?.id) return null;

    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: session.token, staff: session.staff })
    );
  } catch {
    /* Private-mode browsers reject writes; the session simply won't persist. */
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to do. */
  }
}