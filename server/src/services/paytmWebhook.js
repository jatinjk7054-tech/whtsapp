import crypto from 'crypto';
import config from '../config/paymentGatewayConfig.js';
import { processPayment } from './paymentWebhookService.js';

function verifyPaytmChecksum(payload, signature, merchantKey) {
  if (!merchantKey) return false;
  const dataString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const expected = crypto
    .createHmac('sha256', merchantKey)
    .update(dataString)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function handlePaytmWebhook(body, signature) {
  if (!config.paytm.enabled) {
    return { success: false, status: 503, message: 'Paytm integration disabled' };
  }

  if (!verifyPaytmChecksum(body, signature, config.paytm.webhookSecret || config.paytm.merchantKey)) {
    return { success: false, status: 401, message: 'Invalid webhook checksum' };
  }

  const txn = body;

  const txnAmount = parseFloat(txn.TXN_AMOUNT || txn.amount || txn.transactionAmount || 0);
  const orderId = txn.ORDER_ID || txn.orderId || txn.order_id || null;
  const paymentId = txn.TXN_ID || txn.transactionId || txn.paymentId || txn.bankTxnId || null;
  const bankName = txn.BANK_NAME || txn.bankName || txn.bank_name || null;
  const paymentMode = txn.PAYMENT_MODE || txn.paymentMode || txn.payment_mode || 'unknown';
  const status = txn.STATUS || txn.status || null;
  const senderName = txn.CUST_NAME || txn.customerName || txn.name || null;
  const senderEmail = txn.CUST_EMAIL || txn.email || null;
  const senderPhone = txn.MOBILE_NO || txn.mobile || txn.phone || null;

  let gatewaySource = paymentMode;
  if (paymentMode === 'UPI') gatewaySource = 'UPI';
  else if (paymentMode === 'CREDIT_CARD' || paymentMode === 'CC') gatewaySource = 'Credit Card';
  else if (paymentMode === 'DEBIT_CARD' || paymentMode === 'DC') gatewaySource = 'Debit Card';
  else if (paymentMode === 'NET_BANKING' || paymentMode === 'NB') gatewaySource = bankName || 'Net Banking';
  else if (paymentMode === 'WALLET') gatewaySource = 'Wallet';
  else if (paymentMode === 'EMI') gatewaySource = 'EMI';

  if (status === 'TXN_SUCCESS' || status === 'success' || status === 'captured') {
    return await processPayment({
      gateway: 'paytm',
      paymentId,
      orderId,
      amount: txnAmount,
      gatewaySource,
      senderName,
      senderEmail,
      senderPhone,
      eventType: 'payment.captured',
      rawPayload: body,
    });
  }

  return {
    success: true,
    message: `Transaction ${status || 'unknown status'}`,
    paymentId,
    orderId,
    amount: txnAmount,
  };
}
