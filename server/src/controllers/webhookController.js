import { handleRazorpayWebhook, syncRazorpayPayments, invalidateClient } from '../services/razorpayWebhook.js';
import { handlePaytmWebhook } from '../services/paytmWebhook.js';
import { getWebhookLog, countWebhookByStatus } from '../models/paymentWebhookLogModel.js';
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getAccountById,
} from '../models/razorpayAccountModel.js';

export async function razorpayWebhookEntry(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const result = await handleRazorpayWebhook(rawBody, signature, null);
    return res.status(result.status || 200).json(result);
  } catch (error) {
    console.error('[webhook] Razorpay error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function razorpayWebhookForAccount(req, res) {
  try {
    const accountId = Number(req.params.accountId);
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const result = await handleRazorpayWebhook(rawBody, signature, accountId);
    return res.status(result.status || 200).json(result);
  } catch (error) {
    console.error('[webhook] Razorpay per-account error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function paytmWebhookEntry(req, res) {
  try {
    const signature = req.headers['x-checksum'] || req.headers['x-paytm-checksum'] || req.body.CHECKSUMHASH || '';
    const result = await handlePaytmWebhook(req.body, signature);
    return res.status(result.status || 200).json(result);
  } catch (error) {
    console.error('[webhook] Paytm error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function triggerRazorpaySync(req, res) {
  try {
    const result = await syncRazorpayPayments(null);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function triggerRazorpaySyncForAccount(req, res) {
  try {
    const accountId = Number(req.params.id);
    const result = await syncRazorpayPayments(accountId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function getWebhookStatus(req, res) {
  try {
    const counts = await countWebhookByStatus();
    return res.json({ counts });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getWebhookLogs(req, res) {
  try {
    const { gateway, status, account_id } = req.query;
    const log = await getWebhookLog({ gateway, status, account_id, limit: 100 });
    return res.json(log);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// ---- Razorpay accounts CRUD ----

export async function listRazorpayAccounts(req, res) {
  try {
    const accounts = await listAccounts();
    return res.json(accounts);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createRazorpayAccount(req, res) {
  try {
    const { name, key_id, key_secret, webhook_secret, is_active, is_default } = req.body;
    if (!name || !key_id || !key_secret) {
      return res.status(400).json({ message: 'name, key_id, key_secret are required' });
    }
    const account = await createAccount({ name, key_id, key_secret, webhook_secret, is_active, is_default });
    return res.json(account);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateRazorpayAccount(req, res) {
  try {
    const id = Number(req.params.id);
    const updates = { ...req.body };
    // Treat empty secret strings as "no change"
    if (updates.key_secret === '') delete updates.key_secret;
    if (updates.webhook_secret === '') delete updates.webhook_secret;
    const account = await updateAccount(id, updates);
    invalidateClient(id);
    return res.json(account);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function deleteRazorpayAccount(req, res) {
  try {
    const id = Number(req.params.id);
    await deleteAccount(id);
    invalidateClient(id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getRazorpayAccount(req, res) {
  try {
    const id = Number(req.params.id);
    const account = await getAccountById(id);
    if (!account) return res.status(404).json({ message: 'Not found' });
    return res.json(account);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
