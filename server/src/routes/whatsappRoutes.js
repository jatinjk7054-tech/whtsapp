import { Router } from 'express';
import { sendReceipt, sendDirect, serveReceiptFile } from '../controllers/whatsappController.js';
import { authenticateRole } from '../middleware/authMiddleware.js';

const router = Router();
router.post('/send-receipt/:logId', authenticateRole('accounts', 'super_admin'), sendReceipt);
router.post('/send-direct', authenticateRole('accounts', 'super_admin'), sendDirect);

// Meta fetches the template's HEADER document with a plain GET and cannot
// present a session token, so this route is deliberately unauthenticated. The
// HMAC-signed, expiring token in the URL is the authorisation -- it is verified
// before any storage call, and a rejected token answers 404 so the endpoint
// cannot be used to probe which receipt keys exist.
router.get('/receipt-file/:token', serveReceiptFile);

export default router;
