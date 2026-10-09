import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware.js';
import multer from 'multer';
import {
  whatsappAutoLogin,
} from '../controllers/froWhatsAppAuthController.js';
import {
  listConversations,
  listAgentConversations,
  agentUnreadCount,
  listMessages,
  sendMessage,
  sendDirect,
  createConversation,
  markRead,
  unreadCount,
  listQuickReplies,
  listTemplates,
  sendTemplate,
  searchMessages,
  updateLabels,
  uploadMedia,
  listMyAccounts,
  getMedia,
} from '../controllers/froWhatsAppController.js';
import { sendInteractive } from '../controllers/whatsappEnhancementsController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(authenticate);

const ALLOWED_ROLES = ['fro', 'worker', 'agent', 'admin', 'super_admin', 'master'];

const requireWhatsApp = (req, res, next) => {
  const role = req.user?.role;
  if (ALLOWED_ROLES.includes(role)) return next();
  if (req.user?.department && req.user.department.toLowerCase().trim() === 'fro') return next();
  return res.status(403).json({ message: 'Access denied' });
};

router.get('/auto-login', whatsappAutoLogin);

router.use(requireWhatsApp);

router.get('/agent-conversations', listAgentConversations);
router.get('/agent-conversations/unread-count', agentUnreadCount);
router.get('/my-accounts', listMyAccounts);
router.post('/send-direct', sendDirect);
router.post('/create-conversation', createConversation);
router.get('/conversations/:id/messages', listMessages);
router.post('/conversations/:id/send', sendMessage);
router.post('/conversations/:id/send-interactive', sendInteractive);
router.put('/conversations/:id/read', markRead);
router.get('/search', searchMessages);
router.get('/media/:mediaId', getMedia);
router.post('/upload-media', upload.single('file'), uploadMedia);
router.post('/send-template', sendTemplate);
router.get('/quick-replies', listQuickReplies);
router.get('/templates', listTemplates);

router.get('/conversations', listConversations);
router.get('/conversations/unread-count', unreadCount);
router.put('/conversations/:id/labels', updateLabels);

export default router;
