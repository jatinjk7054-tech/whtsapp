const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * The token getter is injected by the app so this module stays free of React
 * state. Nothing secret is ever read from an env var or bundled into the build:
 * the only credential the client holds is the per-login JWT returned by
 * POST /api/staff/login.
 */
let readToken = () => null;

export function setTokenReader(reader) {
  readToken = reader;
}

function describe(payload, fallback) {
  const base = payload?.error ?? fallback;

  const { details } = payload ?? {};
  if (!details) return base;

  if (Array.isArray(details)) {
    const extra = details
      .map((item) => (typeof item === 'string' ? item : item?.message))
      .filter(Boolean)
      .join(' ');
    return extra ? `${base}: ${extra}` : base;
  }

  if (typeof details === 'string') return `${base}: ${details}`;
  if (details.message) return `${base}: ${details.message}`;

  return base;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const token = readToken();

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // A cancelled request is a normal part of polling cleanup, not a failure.
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the server. Is the backend running on port 4000?', 0);
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      describe(payload, `Request failed (${response.status})`),
      response.status,
      payload?.details
    );
  }

  return payload;
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export const api = {
  login: (email, password) => request('/staff/login', { method: 'POST', body: { email, password } }),
  me: (signal) => request('/staff/me', { signal }),
  listStaff: (includeInactive = false, signal) =>
    request(`/staff${includeInactive ? '?includeInactive=true' : ''}`, { signal }),
  createStaff: (body) => request('/staff', { method: 'POST', body }),
  updateStaff: (id, body) => request(`/staff/${id}`, { method: 'PATCH', body }),

  listConversations: (filters = {}, signal) =>
    request(`/conversations${query({ sort: 'recent', limit: 50, offset: 0, ...filters })}`, { signal }),

  getThread: (conversationId, { markRead = true, limit = 100, before } = {}, signal) =>
    request(
      `/conversations/${conversationId}${query({
        markRead: markRead ? 'true' : 'false',
        limit,
        before,
      })}`,
      { signal }
    ),

  claimConversation: (conversationId) =>
    request(`/conversations/${conversationId}/claim`, { method: 'POST' }),

  assignConversation: (conversationId, assignedStaffId) =>
    request(`/conversations/${conversationId}/assign`, {
      method: 'PUT',
      body: { assignedStaffId },
    }),

  setConversationStatus: (conversationId, status) =>
    request(`/conversations/${conversationId}/status`, { method: 'PATCH', body: { status } }),

  sendMessage: (conversationId, body, { replyToId } = {}) =>
    request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { type: 'text', body, ...(replyToId ? { replyToId } : {}) },
    }),
  // Module 11 — retry a failed outgoing message (reuses the same bubble).
  retryMessage: (conversationId, messageId) =>
    request(`/conversations/${conversationId}/messages/${messageId}/retry`, { method: 'POST' }),
  forwardMessage: (targetConversationId, sourceMessageId) =>
    request(`/conversations/${targetConversationId}/forward`, {
      method: 'POST',
      body: { sourceMessageId },
    }),
  searchMessages: (search, signal) =>
    request(`/conversations/messages/search${query({ search, limit: 30 })}`, { signal }),
  sendTemplate: (conversationId, template) =>
    request(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { type: 'template', ...template },
    }),
  sendMedia: (conversationId, payload) =>
    request(`/conversations/${conversationId}/media`, { method: 'POST', body: payload }),
  listTemplates: (signal) => request('/whatsapp/templates', { signal }),
  createConversation: (waId, name = '') =>
    request('/conversations/contact', { method: 'POST', body: { waId, name } }),
  createContact: ({ name, mobile, notes, tags }) =>
    request('/contacts', { method: 'POST', body: { name, mobile, notes, tags } }),
  getContactProfile: (waId, signal) =>
    request(`/contacts/${encodeURIComponent(waId)}/profile`, { signal }),

  // Module 5 — customer tags. The tag catalogue is global; assignments live on
  // the contact and inherit the profile's admin/agent ownership rules.
  listTags: (signal) => request('/tags', { signal }),
  createTag: (body) => request('/tags', { method: 'POST', body }),
  updateTag: (id, body) => request(`/tags/${id}`, { method: 'PATCH', body }),
  deleteTag: (id) => request(`/tags/${id}`, { method: 'DELETE' }),
  addContactTags: (waId, tagIds) =>
    request(`/contacts/${encodeURIComponent(waId)}/tags`, {
      method: 'POST',
      body: { tagIds },
    }),
  removeContactTag: (waId, tagId) =>
    request(`/contacts/${encodeURIComponent(waId)}/tags/${tagId}`, { method: 'DELETE' }),

  // Module 6 — Away Message (Admin only; the backend enforces that) and the
  // shared Quick Reply library (read by everyone, edited by admins).
  getAwaySettings: (signal) => request('/settings/away-message', { signal }),
  saveAwaySettings: (body) => request('/settings/away-message', { method: 'PUT', body }),
  testAwaySettings: (body) =>
    request('/settings/away-message/test', { method: 'POST', body: body ?? {} }),

  listQuickReplies: (search, signal) => request(`/quick-replies${query({ search })}`, { signal }),
  createQuickReply: (body) => request('/quick-replies', { method: 'POST', body }),
  updateQuickReply: (id, body) => request(`/quick-replies/${id}`, { method: 'PATCH', body }),
  deleteQuickReply: (id) => request(`/quick-replies/${id}`, { method: 'DELETE' }),

  // Module 8 — Agent Performance Analytics (Admin only; the backend enforces
  // the admin gate with a 403 for any other role, so these calls only ever run
  // for users the server has already validated).
  getAgentPerformance: (filters = {}, signal) =>
    request(`/admin/agent-performance${query(filters)}`, { signal }),
  getAgentPerformanceDetail: (agentId, { from, to } = {}, signal) =>
    request(`/admin/agent-performance/${agentId}${query({ from, to })}`, { signal }),

  // Module 9 — Advanced WhatsApp Automation (Admin only; the backend enforces
  // the admin gate with 403 for any other role).
  getAutomationSettings: (signal) => request('/automation/settings', { signal }),
  saveAutomationSettings: (body) =>
    request('/automation/settings', { method: 'PUT', body }),
  listAutomationRules: (signal) => request('/automation/rules', { signal }),
  createAutomationRule: (body) => request('/automation/rules', { method: 'POST', body }),
  updateAutomationRule: (id, body) => request(`/automation/rules/${id}`, { method: 'PATCH', body }),
  deleteAutomationRule: (id) => request(`/automation/rules/${id}`, { method: 'DELETE' }),
  testAutomationRule: (body) => request('/automation/test', { method: 'POST', body }),
  listAutomationLogs: (filters = {}, signal) =>
    request(`/automation/logs${query(filters)}`, { signal }),

  // Module 10 — Follow-up Reminders + notification bell. Both roles use these;
  // the backend scopes every call to the caller's own permissions.
  listReminders: (filters = {}, signal) => request(`/reminders${query(filters)}`, { signal }),
  createReminder: (body) => request('/reminders', { method: 'POST', body }),
  getReminder: (id, signal) => request(`/reminders/${id}`, { signal }),
  updateReminder: (id, body) => request(`/reminders/${id}`, { method: 'PATCH', body }),
  completeReminder: (id) => request(`/reminders/${id}/complete`, { method: 'POST' }),
  cancelReminder: (id) => request(`/reminders/${id}/cancel`, { method: 'POST' }),
  reopenReminder: (id) => request(`/reminders/${id}/reopen`, { method: 'POST' }),

  listNotifications: (params = {}, signal) => request(`/notifications${query(params)}`, { signal }),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST' }),

  // Module 12 — WhatsApp voice calling. The browser owns the WebRTC session and
  // only ever sends/receives SDP; no audio touches this API. The backend owns
  // the call state machine and enforces conversation ownership.
  getCallingStatus: (signal) => request('/calls/status', { signal }),
  listIncomingCalls: (signal) => request('/calls/incoming', { signal }),
  getCall: (id, signal) => request(`/calls/${id}`, { signal }),
  startCall: (conversationId, sdpOffer) =>
    request(`/conversations/${conversationId}/calls`, { method: 'POST', body: { sdpOffer } }),
  answerCall: (id, sdpAnswer) =>
    request(`/calls/${id}/answer`, { method: 'POST', body: { sdpAnswer } }),
  rejectCall: (id) => request(`/calls/${id}/reject`, { method: 'POST' }),
  terminateCall: (id) => request(`/calls/${id}/terminate`, { method: 'POST' }),
  listCalls: (conversationId, signal) =>
    request(`/conversations/${conversationId}/calls`, { signal }),
};

/**
 * Best-effort hang-up on page unload. `keepalive` lets the request outlive the
 * document; if the browser drops it anyway, the backend sweeper ends the call.
 */
export function terminateCallOnUnload(id) {
  const token = readToken();
  try {
    fetch(`${BASE_URL}/calls/${id}/terminate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Inbound attachments live behind GET /api/media/:id, which is protected by the
 * same bearer token. A plain <img src> cannot carry that header, so the bytes
 * are fetched as a blob and handed to the UI as an object URL. This also keeps
 * the token out of the URL and out of the DOM.
 */
async function fetchTokenBlob(path, signal) {
  const token = readToken();
  const url = path.startsWith('/api') ? path : `${BASE_URL}${path}`;

  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new ApiError('File could not be loaded', response.status);
  }

  return URL.createObjectURL(await response.blob());
}

export async function fetchMediaObjectUrl(mediaPath, signal) {
  return fetchTokenBlob(mediaPath, signal);
}

const avatarUrlCache = new Map();
const avatarInflight = new Map();

/**
 * Profile pictures are protected by the same bearer token and streamed through
 * GET /api/contacts/:waId/picture. The resolved picture object URL is cached for
 * the page session and in-flight requests are shared, so the header and sidebar
 * do not fetch the same contact twice. The backend rotates its own url cache and
 * refreshes expired CDN urls, so a stale entry here simply refetches once.
 */
export async function fetchAvatarObjectUrl(waId, signal) {
  const encoded = encodeURIComponent(waId);

  if (avatarUrlCache.has(encoded)) return avatarUrlCache.get(encoded);

  const inflight = avatarInflight.get(encoded);
  if (inflight) return inflight;

  const promise = fetchTokenBlob(`/contacts/${encoded}/picture`, signal)
    .then((url) => {
      avatarUrlCache.set(encoded, url);
      return url;
    })
    .finally(() => {
      avatarInflight.delete(encoded);
    });

  avatarInflight.set(encoded, promise);
  return promise;
}