import crypto from 'crypto';
import Razorpay from 'razorpay';
import config from '../config/paymentGatewayConfig.js';
import { processPayment, reversePayment, logEventOnly } from './paymentWebhookService.js';
import {
  getAccountById,
  getActiveAccounts,
  getDefaultAccount,
  updateLastSynced,
  listAccounts,
} from '../models/razorpayAccountModel.js';

function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!webhookSecret) return false;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

// Lazily-built, cached clients keyed by account id.
// `envClient` is the .env fallback (used when DB has no accounts).
const clientCache = new Map();
let envClient = null;

function getEnvClient() {
  if (envClient) return envClient;
  if (config.razorpay.enabled && config.razorpay.keyId && config.razorpay.keySecret) {
    envClient = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return envClient;
}

function getClientForAccount(account) {
  if (!account) return null;
  const cached = clientCache.get(account.id);
  if (cached) return cached;
  const client = new Razorpay({
    key_id: account.key_id,
    key_secret: account.key_secret,
  });
  clientCache.set(account.id, client);
  return client;
}

// Invalidate cache when an account is updated/deleted (called from controller).
export function invalidateClient(accountId) {
  if (accountId != null) clientCache.delete(accountId);
  else clientCache.clear();
}

/**
 * Handle an inbound Razorpay webhook.
 * - If `accountId` is provided, look up that account and verify against its webhook secret.
 * - If no `accountId` and no DB accounts exist, fall back to .env config (legacy behaviour).
 */
export async function handleRazorpayWebhook(rawBody, signature, accountId = null) {
  let account = null;
  let accountClient = null;

  if (accountId != null) {
    account = await getAccountById(accountId, { unmask: true });
    if (!account) {
      return { success: false, status: 404, message: 'Razorpay account not found' };
    }
    if (!account.is_active) {
      return { success: false, status: 503, message: 'Razorpay account disabled' };
    }
    accountClient = getClientForAccount(account);
    if (!verifyWebhookSignature(rawBody, signature, account.webhook_secret)) {
      return { success: false, status: 401, message: 'Invalid webhook signature' };
    }
  } else {
    // Legacy / fallback path: only if no DB accounts exist.
    const active = await getActiveAccounts();
    if (active.length > 0) {
      return {
        success: false,
        status: 400,
        message: 'Use per-account webhook URL: /api/webhooks/razorpay/:accountId',
      };
    }
    if (!config.razorpay.enabled) {
      return { success: false, status: 503, message: 'Razorpay integration disabled' };
    }
    if (!verifyWebhookSignature(rawBody, signature, config.razorpay.webhookSecret)) {
      return { success: false, status: 401, message: 'Invalid webhook signature' };
    }
    accountClient = getEnvClient();
  }

  const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  const event = body.event;
  const payload = body.payload;

  const accountIdForLog = account?.id || null;
  const accountNameForLog = account?.name || null;

  const logCtx = { accountId: accountIdForLog, accountName: accountNameForLog };

  // ---- PAYMENT EVENTS ----

  if (event === 'payment.captured' && payload?.payment?.entity) {
    const payment = payload.payment.entity;
    const amount = (payment.amount || 0) / 100;
    const paymentId = payment.id;
    const orderId = payment.order_id;
    const method = payment.method || 'unknown';
    const email = payment.email || null;
    const contact = payment.contact || null;
    const bank = payment.bank || null;
    const cardLast4 = payment.card?.last4 || null;

    let gatewaySource = method;
    if (method === 'upi') gatewaySource = 'UPI';
    else if (method === 'netbanking') gatewaySource = bank || 'Net Banking';
    else if (method === 'card') gatewaySource = cardLast4 ? `Card (${cardLast4})` : 'Card';
    else if (method === 'wallet') gatewaySource = 'Wallet';
    else if (method === 'emi') gatewaySource = 'EMI';

    return await processPayment({
      gateway: 'razorpay',
      paymentId,
      orderId,
      amount,
      gatewaySource,
      senderName: payment.name || null,
      senderEmail: email,
      senderPhone: contact,
      eventType: event,
      rawPayload: payment,
      ...logCtx,
    });
  }

  if (event === 'payment.authorized' && payload?.payment?.entity) {
    const payment = payload.payment.entity;
    const amount = (payment.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: payment.id,
      amount,
      description: `Authorized - ${payment.method || 'unknown'} (not yet captured)`,
      rawPayload: payment,
      status: 'logged',
      ...logCtx,
    });
  }

  if (event === 'payment.failed' && payload?.payment?.entity) {
    const payment = payload.payment.entity;
    const amount = (payment.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: payment.id,
      amount,
      description: `Failed: ${payment.error_description || 'Unknown reason'}`,
      rawPayload: payment,
      status: 'failed',
      ...logCtx,
    });
  }

  // ---- REFUND EVENTS ----

  if (event === 'refund.processed' && payload?.refund?.entity) {
    const refund = payload.refund.entity;
    const amount = (refund.amount || 0) / 100;
    const originalPaymentId = refund.payment_id;
    const refundId = refund.id;
    return await reversePayment({
      gateway: 'razorpay',
      originalPaymentId,
      reversalId: refundId,
      amount,
      reason: 'refund',
      eventType: event,
      rawPayload: refund,
      ...logCtx,
    });
  }

  if (event === 'refund.created' && payload?.refund?.entity) {
    const refund = payload.refund.entity;
    const amount = (refund.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: refund.payment_id,
      amount,
      description: `Refund initiated: ${refund.id}`,
      rawPayload: refund,
      status: 'logged',
      ...logCtx,
    });
  }

  if (event === 'refund.failed' && payload?.refund?.entity) {
    const refund = payload.refund.entity;
    const amount = (refund.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: refund.payment_id,
      amount,
      description: `Refund failed: ${refund.id}`,
      rawPayload: refund,
      status: 'failed',
      ...logCtx,
    });
  }

  // ---- DISPUTE EVENTS ----

  if (event === 'payment.dispute.created' && payload?.dispute?.entity) {
    const dispute = payload.dispute.entity;
    const amount = (dispute.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: dispute.payment_id,
      amount,
      description: `Dispute created: ${dispute.id} - ${dispute.reason || 'unknown reason'}`,
      rawPayload: dispute,
      status: 'dispute',
      ...logCtx,
    });
  }

  if (event === 'payment.dispute.lost' && payload?.dispute?.entity) {
    const dispute = payload.dispute.entity;
    const amount = (dispute.amount || 0) / 100;
    return await reversePayment({
      gateway: 'razorpay',
      originalPaymentId: dispute.payment_id,
      reversalId: dispute.id,
      amount,
      reason: 'dispute_lost',
      eventType: event,
      rawPayload: dispute,
      ...logCtx,
    });
  }

  if (event === 'payment.dispute.won' && payload?.dispute?.entity) {
    const dispute = payload.dispute.entity;
    const amount = (dispute.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: dispute.payment_id,
      amount,
      description: `Dispute won: ${dispute.id} - funds retained`,
      rawPayload: dispute,
      status: 'logged',
      ...logCtx,
    });
  }

  if (event === 'payment.dispute.closed' && payload?.dispute?.entity) {
    const dispute = payload.dispute.entity;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: dispute.payment_id,
      description: `Dispute closed: ${dispute.id}`,
      rawPayload: dispute,
      status: 'logged',
      ...logCtx,
    });
  }

  // ---- SETTLEMENT EVENTS ----

  if (event === 'settlement.processed' && payload?.settlement?.entity) {
    const settlement = payload.settlement.entity;
    const amount = (settlement.amount || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: settlement.id,
      amount,
      description: `Settlement processed: ₹${amount} to bank account`,
      rawPayload: settlement,
      status: 'logged',
      ...logCtx,
    });
  }

  // ---- INVOICE EVENTS ----

  if (event === 'invoice.paid' && payload?.invoice?.entity) {
    const invoice = payload.invoice.entity;
    const amount = (invoice.amount || invoice.amount_paid || 0) / 100;
    const paymentId = invoice.payment_id || invoice.id;
    return await processPayment({
      gateway: 'razorpay',
      paymentId,
      orderId: invoice.id,
      amount,
      gatewaySource: 'Invoice',
      senderName: invoice.customer_name || null,
      senderEmail: invoice.customer_email || null,
      eventType: event,
      rawPayload: invoice,
      ...logCtx,
    });
  }

  if (event === 'invoice.partially_paid' && payload?.invoice?.entity) {
    const invoice = payload.invoice.entity;
    const amount = (invoice.amount_paid || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: invoice.id,
      amount,
      description: `Invoice partially paid: ${invoice.id}`,
      rawPayload: invoice,
      status: 'logged',
      ...logCtx,
    });
  }

  if (event === 'invoice.expired' && payload?.invoice?.entity) {
    const invoice = payload.invoice.entity;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: invoice.id,
      description: `Invoice expired: ${invoice.id}`,
      rawPayload: invoice,
      status: 'logged',
      ...logCtx,
    });
  }

  // ---- PAYMENT LINK EVENTS ----

  if (event === 'payment_link.paid' && payload?.payment_link?.entity) {
    const link = payload.payment_link.entity;
    const payment = payload.payment?.entity;
    const amount = (link.amount || (payment ? payment.amount : 0) || 0) / 100;
    const paymentId = payment?.id || link.id;
    const method = payment?.method || 'unknown';

    let gatewaySource = 'Payment Link';
    if (payment) {
      if (method === 'upi') gatewaySource = 'UPI Link';
      else if (method === 'netbanking') gatewaySource = payment.bank || 'Net Banking Link';
      else if (method === 'card') gatewaySource = payment.card?.last4 ? `Card Link (${payment.card.last4})` : 'Card Link';
    }

    return await processPayment({
      gateway: 'razorpay',
      paymentId,
      orderId: link.id,
      amount,
      gatewaySource,
      senderName: link.customer?.name || payment?.name || null,
      senderEmail: link.customer?.email || payment?.email || null,
      senderPhone: link.customer?.contact || payment?.contact || null,
      eventType: event,
      rawPayload: { link, payment },
      ...logCtx,
    });
  }

  if (event === 'payment_link.partially_paid' && payload?.payment_link?.entity) {
    const link = payload.payment_link.entity;
    const amount = (link.amount_paid || 0) / 100;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: link.id,
      amount,
      description: `Payment link partially paid: ${link.id}`,
      rawPayload: link,
      status: 'logged',
      ...logCtx,
    });
  }

  if (event === 'payment_link.cancelled' && payload?.payment_link?.entity) {
    const link = payload.payment_link.entity;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: link.id,
      description: `Payment link cancelled: ${link.id}`,
      rawPayload: link,
      status: 'logged',
      ...logCtx,
    });
  }

  if (event === 'payment_link.expired' && payload?.payment_link?.entity) {
    const link = payload.payment_link.entity;
    return await logEventOnly({
      gateway: 'razorpay',
      eventType: event,
      paymentId: link.id,
      description: `Payment link expired: ${link.id}`,
      rawPayload: link,
      status: 'logged',
      ...logCtx,
    });
  }

  // ---- UNHANDLED ----

  return await logEventOnly({
    gateway: 'razorpay',
    eventType: event,
    description: `Unhandled event`,
    rawPayload: body,
    status: 'unhandled',
    ...logCtx,
  });
}

export async function fetchRazorpayPayments(client, options = {}) {
  if (!client) throw new Error('Razorpay client not available');
  const from = options.from || Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const to = options.to || Math.floor(Date.now() / 1000);
  const payments = await client.payments.all({
    from,
    to,
    count: options.count || 100,
    skip: options.skip || 0,
  });
  return payments;
}

/**
 * Sync a single Razorpay account by id.
 * Falls back to the .env default account when `accountId` is null/undefined
 * AND there are no DB accounts (legacy behaviour for the global Sync button).
 */
export async function syncRazorpayPayments(accountId = null) {
  let account = null;
  let client = null;

  if (accountId != null) {
    account = await getAccountById(accountId, { unmask: true });
    if (!account) return { success: false, message: 'Razorpay account not found', count: 0 };
    if (!account.is_active) return { success: false, message: 'Account disabled', count: 0 };
    client = getClientForAccount(account);
  } else {
    const def = await getDefaultAccount({ unmask: true });
    if (def) {
      account = def;
      client = getClientForAccount(account);
    } else {
      const active = await getActiveAccounts();
      if (active.length > 0) {
        return {
          success: false,
          message: 'No default Razorpay account set. Mark one as default or sync per-account.',
          count: 0,
        };
      }
      client = getEnvClient();
      if (!client) {
        return { success: false, message: 'Razorpay not configured', count: 0 };
      }
    }
  }

  const accountIdForLog = account?.id || null;
  const accountNameForLog = account?.name || null;
  let imported = 0;
  let errors = 0;

  try {
    const payments = await fetchRazorpayPayments(client, { count: 50 });
    const captured = (payments.items || []).filter(p => p.status === 'captured');

    for (const payment of captured) {
      try {
        const amount = (payment.amount || 0) / 100;
        const paymentId = payment.id;
        const orderId = payment.order_id;
        const method = payment.method || 'unknown';
        const email = payment.email || null;
        const contact = payment.contact || null;
        const bank = payment.bank || null;

        let gatewaySource = method;
        if (method === 'upi') gatewaySource = 'UPI';
        else if (method === 'netbanking') gatewaySource = bank || 'Net Banking';
        else if (method === 'card') gatewaySource = payment.card?.last4 ? `Card (${payment.card.last4})` : 'Card';

        const result = await processPayment({
          gateway: 'razorpay',
          paymentId,
          orderId,
          amount,
          gatewaySource,
          senderName: payment.name || null,
          senderEmail: email,
          senderPhone: contact,
          eventType: 'sync',
          rawPayload: payment,
          accountId: accountIdForLog,
          accountName: accountNameForLog,
        });

        if (result.success) imported++;
        else errors++;
      } catch {
        errors++;
      }
    }

    if (account) await updateLastSynced(account.id);

    return {
      success: true,
      message: `Synced ${account ? `(${account.name})` : '(env)'}: ${imported} imported, ${errors} errors`,
      count: imported,
      account: account ? { id: account.id, name: account.name } : null,
    };
  } catch (error) {
    return { success: false, message: error.message, count: 0 };
  }
}

/**
 * Sync all active Razorpay accounts (each account's last N captured payments).
 * Falls back to .env if no DB accounts exist.
 * Used by the auto-sync cron job.
 */
export async function syncAllRazorpayAccounts() {
  const results = { total: 0, imported: 0, errors: 0, accounts: [] };

  const dbAccounts = await getActiveAccounts();
  if (dbAccounts.length > 0) {
    for (const account of dbAccounts) {
      try {
        const result = await syncRazorpayPayments(account.id);
        results.total++;
        results.imported += result.count || 0;
        if (!result.success) results.errors++;
        results.accounts.push({ id: account.id, name: account.name, result });
      } catch (err) {
        results.errors++;
        results.accounts.push({ id: account.id, name: account.name, result: { success: false, message: err.message } });
      }
    }
  } else {
    // .env fallback
    try {
      const result = await syncRazorpayPayments(null);
      results.total++;
      results.imported += result.count || 0;
      if (!result.success) results.errors++;
      results.accounts.push({ id: null, name: '.env', result });
    } catch (err) {
      results.errors++;
      results.accounts.push({ id: null, name: '.env', result: { success: false, message: err.message } });
    }
  }

  return results;
}
