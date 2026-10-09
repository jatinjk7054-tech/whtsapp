import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware.js';
import { getMessages, createMessage, updateMessage, getMessageCounts, getConversations, getConversation, createConversation, updateConversation, getConversationCounts, getConversationByContact } from '../controllers/whatsappCrmDataController.js';

const router = Router();

router.get('/messages', authenticate, getMessages);
router.post('/messages', authenticate, createMessage);
router.put('/messages/:id', authenticate, updateMessage);
router.get('/messages/counts', authenticate, getMessageCounts);

router.get('/conversations', authenticate, getConversations);
router.get('/conversations/counts', authenticate, getConversationCounts);
router.get('/conversations/by-contact', authenticate, getConversationByContact);
router.get('/conversations/:id', authenticate, getConversation);
router.post('/conversations', authenticate, createConversation);
router.put('/conversations/:id', authenticate, updateConversation);

export default router;
