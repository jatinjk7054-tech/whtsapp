import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import multer from 'multer';
import {
  listConversations,
  listPeople,
  openDirect,
  listMessages,
  sendMessage,
  markRead,
  searchMessages,
  editMessage,
  deleteMessage,
  unreadCount,
} from '../controllers/chatController.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { chatWriter } from '../middleware/chatAccess.js';

/**
 * Community Chat routes (plan.md §2.2, §6).
 *
 * `authenticate` only - never `authenticateRole` on the router - because the six
 * read-only roles are legitimate users of this feature. Posting rights are added
 * per route by `chatWriter`.
 *
 * Static paths are declared before `/:id` patterns so `conversations/direct`
 * is not captured as a conversation id.
 */

const router = Router();

// Chat keeps its own 25 MB cap rather than raising the global uploader's. A
// rejected file must fail before it is buffered into memory.
const uploadChat = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/**
 * Per-user send limit. express-rate-limit is already a dependency but unused
 * anywhere in the repo, so chat is where it gets its first use: a stuck client
 * retry loop or a scripted client would otherwise write the whole table.
 */
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // `authenticate` runs first, so the JWT subject is always present. The IP
  // fallback is only a safety net, and goes through ipKeyGenerator so a single
  // IPv6 client cannot rotate addresses to reset its own limit.
  keyGenerator: (req) =>
    String(req.user?.id ?? req.user?.email ?? '') || ipKeyGenerator(req.ip),
  message: { message: 'You are sending messages too quickly. Try again in a minute.' },
});

router.use(authenticate);

router.get('/people', chatWriter, listPeople);
router.get('/unread-count', unreadCount);

router.get('/conversations', listConversations);
router.post('/conversations/direct', chatWriter, openDirect);
router.get('/conversations/:id/messages', listMessages);
router.get('/conversations/:id/search', searchMessages);
router.post('/conversations/:id/read', markRead);
router.post('/conversations/:id/messages', chatWriter, sendLimiter, uploadChat.single('file'), sendMessage);

router.patch('/messages/:id', chatWriter, editMessage);
router.delete('/messages/:id', chatWriter, deleteMessage);

export default router;
