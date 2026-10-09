import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import db from './config/db.js';

let io = null;

// Live-socket presence: worker ids holding at least one authenticated socket
// right now. This is the source of truth for "panel open", replacing timer
// heartbeats. Same-process only (single PM2 fork) — do NOT rely on this if
// the backend ever moves to multi-process cluster mode (would need redis).
const workerSockets = new Map(); // workerId (string) -> Set<socket.id>

export function isWorkerOnline(workerId) {
  if (workerId == null) return false;
  const set = workerSockets.get(String(workerId));
  return !!set && set.size > 0;
}

export function getOnlineWorkerIds() {
  const out = [];
  for (const [wid, set] of workerSockets) if (set.size > 0) out.push(wid);
  return out;
}

function trackPresence(socket) {
  const wid = socket.user && (socket.user.workerId || socket.user.id);
  if (wid == null) return null;
  const key = String(wid);
  let set = workerSockets.get(key);
  if (!set) {
    set = new Set();
    workerSockets.set(key, set);
  }
  set.add(socket.id);
  socket.on('disconnect', () => {
    const s = workerSockets.get(key);
    if (!s) return;
    s.delete(socket.id);
    if (s.size === 0) workerSockets.delete(key);
  });
  return key;
}

export function initRealtime(server) {
  if (io) return io;
  io = new Server(server, {
    cors: { origin: '*' },
    path: '/socket.io',
  });

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth && socket.handshake.auth.token) ||
      (socket.handshake.headers && socket.handshake.headers.authorization && socket.handshake.headers.authorization.split(' ')[1]);
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const role = (socket.user && socket.user.role) || 'unknown';
    socket.join(`role:${role}`);
    // FRO login tokens carry `id` (not `workerId`) — join both spellings so
    // worker-targeted events (fro:pause, fro:resume, …) actually reach panels.
    // Without this, pause/resume emits silently go nowhere.
    const wid = socket.user && (socket.user.workerId || socket.user.id);
    if (wid) socket.join(`worker:${wid}`);
    // Work-as: the token's `id` is the COVERED FRO, so this socket's presence
    // lands in the covered worker's room and isWorkerOnline() reports the person
    // who is not at the keyboard as the one online. Join the operator's room too
    // — their own live row is the one that now carries their presence, and it is
    // checked with isWorkerOnline(operator). Without this the covering operator
    // reads as offline on every board.
    const opWid = socket.user && socket.user.impersonation && socket.user.imposter_id;
    if (opWid) socket.join(`worker:${opWid}`);
    // Presence: an open authenticated socket means the panel is open, no
    // heartbeat timer needed. Multi-tab = multiple socket ids, one entry.
    trackPresence(socket);

    // Award ceremony voting: every logged-in employee needs "your turn is open"
    // and "the ceremony just started" pushes, but the payloads carry no ballot
    // detail - only counts and state. One shared room is correct here, and is
    // deliberately NOT a db:change broadcast.
    socket.join('voting');

    // Community Chat: join one room per conversation this identity participates
    // in, so typing frames reach the right people. A direct conversation is only
    // ever joined by its two participants, so a read-only role structurally
    // cannot receive a DM typing frame. Resolved from chat_participants rather
    // than from the JWT role, which is what keeps the two in step.
    //
    // A DM opened after connect is a room this socket has never joined, so the
    // client asks again once it creates a conversation - otherwise the two
    // people in a brand new DM get no live messages until they reload.
    const rejoinChatRooms = () =>
      joinChatRooms(socket).catch((e) =>
        console.warn('[socket] chat room join failed:', e?.message || String(e))
      );
    rejoinChatRooms();
    socket.on('chat:join', rejoinChatRooms);
    socket.on('chat:typing', (payload) => relayTyping(socket, payload));
  });

  return io;
}

/**
 * Puts a newly connected socket into the chat rooms it is entitled to.
 *
 * Runs asynchronously after connect so a slow query cannot delay the socket
 * handshake for panels that are not even using chat.
 */
async function joinChatRooms(socket) {
  const user = socket.user;
  if (!user) return;
  const email = String(user.email || '').trim().toLowerCase();
  const uid = email
    ? `email:${email}`
    : (user.id ?? user.workerId) != null && String(user.id ?? user.workerId) !== ''
      ? `login:${user.id ?? user.workerId}`
      : null;
  if (!uid) return;

  const { rows } = await db._pool.query(
    `SELECT conversation_id FROM chat_participants WHERE uid = $1`,
    [uid]
  );
  for (const r of rows) socket.join(`chat:${r.conversation_id}`);
}

/**
 * Relays a typing indicator to the rest of the conversation.
 *
 * Authorisation is re-checked here rather than trusted from the client: the
 * socket only relays into a room the sender has actually joined, so a forged
 * conversation_id cannot fan out into someone else's thread.
 */
function relayTyping(socket, payload) {
  const conversationId = Number(payload?.conversation_id);
  if (!Number.isInteger(conversationId)) return;
  if (!socket.rooms.has(`chat:${conversationId}`)) return;
  socket.to(`chat:${conversationId}`).emit('chat:typing', {
    conversation_id: conversationId,
    uid: chatUidOf(socket.user),
    name: socket.user?.name || '',
    typing: !!payload?.typing,
  });
}

/** Mirrors chatModel.chatUidFor so both sides derive the same key. */
function chatUidOf(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const id = user?.id ?? user?.workerId;
  if (id != null && String(id) !== '') return `login:${id}`;
  return null;
}

export function emitDbChange(payload) {
  if (!io) return;
  io.emit('db:change', payload);
}

/**
 * Emits a chat event to one conversation room only.
 *
 * Chat deliberately does NOT go through emitDbChange: that is an io.emit to
 * every connected socket, so a DM body would be pushed to all six read-only
 * roles. The client would not render it (the conversation is not in their list)
 * but it would still cross the wire and sit in their tab's memory. Room-scoped
 * emit is the only thing that keeps a DM inside the DM.
 */
export function emitChat(conversationId, payload) {
  if (!io) return;
  io.to(`chat:${conversationId}`).emit('chat:message', payload);
}

export function emitRealtime(event, payload, room) {
  if (!io) return;
  const target = room ? io.to(room) : io;
  target.emit(event, payload);
}

export function isRealtimeInitialized() {
  return !!io;
}
