import { Router } from 'express';
import { authenticateRole } from '../middleware/authMiddleware.js';
import {
  razorpayWebhookEntry, razorpayWebhookForAccount, paytmWebhookEntry,
  triggerRazorpaySync, triggerRazorpaySyncForAccount,
  getWebhookStatus, getWebhookLogs,
  listRazorpayAccounts, createRazorpayAccount, updateRazorpayAccount,
  deleteRazorpayAccount, getRazorpayAccount,
} from '../controllers/webhookController.js';
import { verifyWhatsAppWebhook, whatsappWebhookEntry } from '../controllers/whatsappWebhookController.js';

const router = Router();

// ---- Authenticated endpoints (panel users) — registered FIRST so they win
//       over the public param route `/razorpay/:accountId`. ----

router.get('/status', authenticateRole('accounts', 'super_admin'), getWebhookStatus);
router.get('/log', authenticateRole('accounts', 'super_admin'), getWebhookLogs);

// Razorpay accounts CRUD
router.get('/razorpay/accounts', authenticateRole('accounts', 'super_admin'), listRazorpayAccounts);
router.post('/razorpay/accounts', authenticateRole('accounts', 'super_admin'), createRazorpayAccount);
router.get('/razorpay/accounts/:id', authenticateRole('accounts', 'super_admin'), getRazorpayAccount);
router.put('/razorpay/accounts/:id', authenticateRole('accounts', 'super_admin'), updateRazorpayAccount);
router.delete('/razorpay/accounts/:id', authenticateRole('accounts', 'super_admin'), deleteRazorpayAccount);

// Sync (global = default account; per-account)
router.post('/razorpay/sync', authenticateRole('accounts', 'super_admin'), triggerRazorpaySync);
router.post('/razorpay/accounts/:id/sync', authenticateRole('accounts', 'super_admin'), triggerRazorpaySyncForAccount);

// ---- Public webhook endpoints (called by Razorpay/Paytm) — registered LAST
//       so authenticated specific paths above take precedence. ----

router.post('/razorpay', razorpayWebhookEntry);            // legacy / .env fallback
router.post('/razorpay/:accountId', razorpayWebhookForAccount); // per-account
router.post('/paytm', paytmWebhookEntry);

// WhatsApp (Meta) webhook — public; GET verifies the subscription, POST handles inbound.
router.get('/whatsapp', verifyWhatsAppWebhook);
router.post('/whatsapp', whatsappWebhookEntry);

export default router;
