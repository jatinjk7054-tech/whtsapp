import db from '../config/db.js';
import { logWebhook } from '../models/paymentWebhookLogModel.js';
import { getSources, getEntryByPaymentId } from '../models/bankAuditModel.js';

let cachedSources = null;
let lastSourceFetch = 0;

async function getSourceIdByName(name) {
  const now = Date.now();
  if (!cachedSources || now - lastSourceFetch > 60000) {
    cachedSources = await getSources();
    lastSourceFetch = now;
  }
  const match = cachedSources.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (match) return match.id;
  return null;
}

export async function ensureRazorpaySource() {
  const sources = await getSources();
  const exists = sources.find(s => s.name === 'Razorpay');
  if (exists) return exists.id;
  const { data, error } = await db
    .from('bank_audit_sources')
    .insert({ name: 'Razorpay', sort_order: 2 })
    .select()
    .single();
  if (error) throw error;
  cachedSources = null;
  return data.id;
}

export async function ensurePaytmSource() {
  const sources = await getSources();
  const exists = sources.find(s => s.name === 'Paytm');
  if (exists) return exists.id;
  const { data, error } = await db
    .from('bank_audit_sources')
    .insert({ name: 'Paytm', sort_order: 7 })
    .select()
    .single();
  if (error) throw error;
  cachedSources = null;
  return data.id;
}

export async function processPayment({
  gateway, paymentId, orderId, amount, gatewaySource,
  senderName, senderEmail, senderPhone, eventType, rawPayload,
  accountId, accountName,
}) {
  try {
    let sourceId;
    if (gateway === 'razorpay') {
      sourceId = await ensureRazorpaySource();
    } else if (gateway === 'paytm') {
      sourceId = await ensurePaytmSource();
    } else {
      sourceId = await getSourceIdByName(gateway);
    }

    if (!sourceId) {
      sourceId = 1;
    }

    // Dedup: skip if this payment already exists (any status)
    if (paymentId) {
      const existing = await getEntryByPaymentId(paymentId, null);
      if (existing) {
        await logWebhook({
          gateway,
          event_type: eventType || null,
          payment_id: paymentId || null,
          order_id: orderId || null,
          amount,
          gateway_source: gatewaySource || null,
          sender_name: senderName || null,
          sender_email: senderEmail || null,
          sender_phone: senderPhone || null,
          raw_payload: rawPayload || null,
          bank_entry_id: existing.id,
          status: 'skipped_duplicate',
          error_message: null,
          account_id: accountId || null,
          account_name: accountName || null,
        });
        return { success: true, skipped: true, entry: existing };
      }
    }

    const remarks = [
      `Via ${gateway}`,
      accountName ? `[${accountName}]` : '',
      gatewaySource ? `(${gatewaySource})` : '',
      orderId ? `Order: ${orderId}` : '',
      senderName ? `- ${senderName}` : '',
    ].filter(Boolean).join(' ');

    if (paymentId) {
      const { data: duplicateCheck } = await db
        .from('bank_audit_entries')
        .select('id')
        .eq('payment_id', paymentId)
        .limit(1);
      if (duplicateCheck && duplicateCheck.length > 0) {
        await logWebhook({
          gateway,
          event_type: eventType || null,
          payment_id: paymentId || null,
          order_id: orderId || null,
          amount,
          gateway_source: gatewaySource || null,
          sender_name: senderName || null,
          sender_email: senderEmail || null,
          sender_phone: senderPhone || null,
          raw_payload: rawPayload || null,
          bank_entry_id: duplicateCheck[0].id,
          status: 'skipped_duplicate',
          error_message: null,
          account_id: accountId || null,
          account_name: accountName || null,
        });
        return { success: true, skipped: true, entry: duplicateCheck[0] };
      }
    }

    const { data: entry, error: entryError } = await db
      .from('bank_audit_entries')
      .insert({
        source_id: sourceId,
        amount,
        payment_id: paymentId || null,
        transaction_date: new Date().toISOString().slice(0, 10),
        remarks,
        created_by: null,
      })
      .select()
      .single();

    if (entryError) throw entryError;

    await logWebhook({
      gateway,
      event_type: eventType || null,
      payment_id: paymentId || null,
      order_id: orderId || null,
      amount,
      gateway_source: gatewaySource || null,
      sender_name: senderName || null,
      sender_email: senderEmail || null,
      sender_phone: senderPhone || null,
      raw_payload: rawPayload || null,
      bank_entry_id: entry.id,
      status: 'processed',
      error_message: null,
      account_id: accountId || null,
      account_name: accountName || null,
    });

    console.log(`[paymentWebhook] ${gateway}${accountName ? `/${accountName}` : ''}: ₹${amount} (${paymentId || orderId || 'no id'}) -> bank_audit_entry #${entry.id}`);
    return { success: true, entry };
  } catch (error) {
    console.error(`[paymentWebhook] ${gateway} processing error:`, error.message);
    try {
      await logWebhook({
        gateway,
        event_type: eventType || null,
        payment_id: paymentId || null,
        order_id: orderId || null,
        amount,
        gateway_source: gatewaySource || null,
        sender_name: senderName || null,
        sender_email: senderEmail || null,
        sender_phone: senderPhone || null,
        raw_payload: rawPayload || null,
        status: 'failed',
        error_message: error.message,
        account_id: accountId || null,
        account_name: accountName || null,
      });
    } catch {}
    return { success: false, error: error.message };
  }
}

/**
 * Create a reversing (negative) Bank Audit entry for refunds / disputes lost.
 * The original captured entry is left intact for audit trail; a new negative
 * entry is inserted with a reference to the original payment_id.
 */
export async function reversePayment({
  gateway, originalPaymentId, reversalId, amount, reason,
  eventType, rawPayload, accountId, accountName,
}) {
  try {
    let sourceId;
    if (gateway === 'razorpay') {
      sourceId = await ensureRazorpaySource();
    } else if (gateway === 'paytm') {
      sourceId = await ensurePaytmSource();
    } else {
      sourceId = await getSourceIdByName(gateway);
    }
    if (!sourceId) sourceId = 1;

    const remarks = [
      `REVERSAL (${reason || eventType || 'refund'})`,
      accountName ? `[${accountName}]` : '',
      `for ${originalPaymentId || 'unknown'}`,
      reversalId ? `- ${reversalId}` : '',
    ].filter(Boolean).join(' ');

    const { data: entry, error: entryError } = await db
      .from('bank_audit_entries')
      .insert({
        source_id: sourceId,
        amount: -Math.abs(amount),
        payment_id: reversalId || null,
        transaction_date: new Date().toISOString().slice(0, 10),
        remarks,
        created_by: null,
      })
      .select()
      .single();

    if (entryError) throw entryError;

    await logWebhook({
      gateway,
      event_type: eventType || null,
      payment_id: originalPaymentId || null,
      order_id: reversalId || null,
      amount: -Math.abs(amount),
      gateway_source: reason || null,
      raw_payload: rawPayload || null,
      bank_entry_id: entry.id,
      status: 'processed',
      account_id: accountId || null,
      account_name: accountName || null,
    });

    console.log(`[paymentWebhook] REVERSAL ${gateway}${accountName ? `/${accountName}` : ''}: -₹${amount} (${originalPaymentId}) -> bank_audit_entry #${entry.id}`);
    return { success: true, entry };
  } catch (error) {
    console.error(`[paymentWebhook] reversal error:`, error.message);
    try {
      await logWebhook({
        gateway,
        event_type: eventType || null,
        payment_id: originalPaymentId || null,
        amount: -Math.abs(amount || 0),
        gateway_source: reason || null,
        raw_payload: rawPayload || null,
        status: 'failed',
        error_message: error.message,
        account_id: accountId || null,
        account_name: accountName || null,
      });
    } catch {}
    return { success: false, error: error.message };
  }
}

/**
 * Log a webhook event without creating/modifying Bank Audit entries.
 * Used for: payment.authorized, refund.created, refund.failed,
 * payment.dispute.created/won/closed, settlement.processed, etc.
 */
export async function logEventOnly({
  gateway, eventType, paymentId, amount, description,
  rawPayload, accountId, accountName, status,
}) {
  try {
    await logWebhook({
      gateway,
      event_type: eventType || null,
      payment_id: paymentId || null,
      amount: amount || null,
      gateway_source: description || null,
      raw_payload: rawPayload || null,
      status: status || 'logged',
      account_id: accountId || null,
      account_name: accountName || null,
    });

    console.log(`[paymentWebhook] LOG ${gateway}${accountName ? `/${accountName}` : ''}: ${eventType} (${paymentId || 'no id'})${amount ? ` ₹${amount}` : ''}`);
    return { success: true, logged: true };
  } catch (error) {
    console.error(`[paymentWebhook] log-only error:`, error.message);
    return { success: false, error: error.message };
  }
}
