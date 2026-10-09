import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import groq, { GROQ_CHAT_MODEL } from '../config/groq.js';
import emailConfig from '../config/emailConfig.js';
import db from '../config/db.js';
import { isEmailProcessed, logImport } from '../models/emailImportLogModel.js';
import { getSources } from '../models/bankAuditModel.js';
import { createEntry } from '../models/bankAuditModel.js';
import { getActiveAccounts, updateLastPolled } from '../models/emailAccountModel.js';

let lastPollResult = { success: null, message: 'Not run yet', count: 0, timestamp: null, error: null };

const BANK_EMAIL_DOMAINS = [
  { domain: 'axisbank.com', source: 'Axis Bank' },
  { domain: 'hdfcbank.com', source: 'HDFC Bank' },
  { domain: 'icicibank.com', source: 'ICICI Bank' },
  { domain: 'sbicard.com', source: 'SBI' },
  { domain: 'onlinesbi.com', source: 'SBI' },
  { domain: 'sbi.co.in', source: 'SBI' },
  { domain: 'yesbank.in', source: 'Yes Bank' },
  { domain: 'kotak.com', source: 'Kotak Mahindra' },
  { domain: 'rblbank.com', source: 'RBL Bank' },
  { domain: 'idfcfirstbank.com', source: 'IDFC First Bank' },
  { domain: 'indusind.com', source: 'IndusInd Bank' },
  { domain: 'federalbank.co.in', source: 'Federal Bank' },
  { domain: 'canarabank.com', source: 'Canara Bank' },
  { domain: 'pnb.co.in', source: 'PNB' },
  { domain: 'bankofbaroda.com', source: 'Bank of Baroda' },
  { domain: 'unionbankofindia.com', source: 'Union Bank' },
  { domain: 'bankofindia.co.in', source: 'Bank of India' },
  { domain: 'centralbankofindia.co.in', source: 'Central Bank' },
  { domain: 'dbs.com', source: 'DBS Bank' },
  { domain: 'gpay.com', source: 'Google Pay' },
  { domain: 'googlepay', source: 'Google Pay' },
  { domain: 'razorpay.com', source: 'Razorpay' },
  { domain: 'paytm.com', source: 'Paytm' },
  { domain: 'phonepe.com', source: 'PhonePe' },
  { domain: 'payu.in', source: 'PayU Money' },
  { domain: 'payumoney', source: 'PayU Money' },
];

function detectSourceFromSender(emailFrom) {
  if (!emailFrom) return null;
  const lower = emailFrom.toLowerCase();
  for (const entry of BANK_EMAIL_DOMAINS) {
    if (lower.includes(entry.domain)) return entry.source;
  }
  return null;
}

function normalizeSourceName(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  const map = {
    'gpay': 'Google Pay',
    'google pay': 'Google Pay',
    'googlepay': 'Google Pay',
    'g-pay': 'Google Pay',
    'phonepe': 'PhonePe',
    'phone pe': 'PhonePe',
    'paytm': 'Paytm',
    'razorpay': 'Razorpay',
    'payu': 'PayU Money',
    'payu money': 'PayU Money',
    'payumoney': 'PayU Money',
    'axis bank': 'Axis Bank',
    'axis': 'Axis Bank',
    'saraswat bank': 'Saraswat Bank',
    'saraswat': 'Saraswat Bank',
    'hdfc': 'HDFC Bank',
    'hdfc bank': 'HDFC Bank',
    'icici': 'ICICI Bank',
    'icici bank': 'ICICI Bank',
    'sbi': 'SBI',
    'state bank of india': 'SBI',
    'yes bank': 'Yes Bank',
    'kotak': 'Kotak Mahindra',
    'kotak mahindra': 'Kotak Mahindra',
    'idfc': 'IDFC First Bank',
    'idfc first': 'IDFC First Bank',
    'indusind': 'IndusInd Bank',
    'federal bank': 'Federal Bank',
    'canara bank': 'Canara Bank',
    'pnb': 'PNB',
    'bank of baroda': 'Bank of Baroda',
    'union bank': 'Union Bank',
    'bank of india': 'Bank of India',
    'central bank': 'Central Bank',
    'dbs bank': 'DBS Bank',
    'rbl bank': 'RBL Bank',
    'check': 'Check',
    'cheque': 'Check',
    'cash': 'Cash',
    'bank transfer': 'Bank Transfer',
    'neft': 'Bank Transfer',
    'imps': 'Bank Transfer',
    'rtgs': 'Bank Transfer',
    'upi': 'UPI',
  };
  return map[n] || name.trim();
}

// Bank alert sources come from a bank, not a person. Their credit emails carry
// no real sender, so the payer is the bank itself.
const BANK_SOURCES = new Set([
  'Axis Bank', 'HDFC Bank', 'ICICI Bank', 'SBI', 'Yes Bank', 'Kotak Mahindra',
  'RBL Bank', 'IDFC First Bank', 'IndusInd Bank', 'Federal Bank', 'Canara Bank',
  'PNB', 'Bank of Baroda', 'Union Bank', 'Bank of India', 'Central Bank', 'DBS Bank',
]);

const isBankSource = (name) => !!name && BANK_SOURCES.has(name);

/**
 * Normalises a bank-alert reference into a clean payment id.
 * e.g. "NEFT/INDBH01093431022/SEAT." -> "INDBH01093431022".
 * Strips the "NEFT/"-style prefix, the trailing "/SEAT"-style suffix and any
 * trailing punctuation.
 */
function cleanPaymentId(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  // X/MID/TAIL with a known transfer prefix: keep only the middle token.
  const prefixed = s.match(/^(NEFT|IMPS|RTGS|UPI|UA|NACH|CHQ|FT)[:/]+\s*([^/]+)\//i);
  if (prefixed) s = prefixed[2];
  s = s.replace(/^(NEFT|IMPS|RTGS|UPI|UA|NACH|CHQ|FT)[:\/\s-]*/i, '');
  s = s.replace(/\/.*$/, '');
  s = s.replace(/\s*[.,;:]+$/, '').trim();
  return s.length ? s : null;
}

async function getOrCreateSourceId(sources, name) {
  const normalized = normalizeSourceName(name);
  if (!normalized) return null;
  let match = sources.find(s => s.name.toLowerCase() === normalized.toLowerCase());
  if (match) return match.id;
  const { data: newSource, error } = await db
    .from('bank_audit_sources')
    .insert({ name: normalized, sort_order: 99 })
    .select()
    .single();
  if (error) return null;
  sources.push(newSource);
  return newSource.id;
}

async function extractPaymentDetails(emailText, emailSubject, emailFrom) {
  const lower = ((emailText || '') + ' ' + (emailSubject || '')).toLowerCase();
  const creditWords = ['credited', 'deposited', 'received', 'credit', 'deposit', 'money received', 'payment received', 'amount credited', 'transfer received', 'accredited'];
  const hasCredit = creditWords.some(k => lower.includes(k));
  if (!hasCredit) return null;

  const textToAnalyze = [
    emailSubject ? `Subject: ${emailSubject}` : '',
    emailFrom ? `From: ${emailFrom}` : '',
    emailText ? `Body:\n${emailText.slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n');

  if (!textToAnalyze) return null;

  const now = Date.now();
  const waitTime = 1500 - (now - (global.__groqLastCall || 0));
  if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));

  try {
    global.__groqLastCall = Date.now();
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are a payment receipt parser. Extract payment details from the email text.

The email could be from:
- Bank transaction alerts (Axis Bank, HDFC, ICICI, SBI etc) - look for "credited", "deposited", "transaction", "NEFT", "IMPS", "RTGS", "UPI ref"
- Payment gateways (GPay, Razorpay, Paytm, PhonePe) - look for "payment received", "money received", "transfer"
- Donor payment confirmation emails

Return ONLY valid JSON with these fields (use null for missing):
{
  "amount": number or null,
  "payment_id": "transaction ID / UPI ref / payment reference or null",
  "transaction_date": "YYYY-MM-DD or null",
  "sender_name": "name of the person who paid or null",
  "payment_source": "Axis Bank / HDFC Bank / ICICI Bank / SBI / GPay / Razorpay / Paytm / PhonePe / etc or null",
  "confidence": "high / medium / low"
}

Rules:
- Amount should be a number (remove currency symbols, commas)
- Payment source: detect from email content - if it mentions a bank name like Axis/HDFC/SBI/ICICI, use that
- For bank transfer emails, set payment_source to the bank name
- Transaction date: prefer date from email if present, else use null
- sender_name: the person who made the payment (for banks, look for "from" or sender name in narration)
- For bank credit alerts (NEFT/IMPS/RTGS/UPI to your account): there is NO sender person in the alert, so always set sender_name to the bank name (e.g. "Axis Bank", "HDFC Bank").
- payment_id for bank alerts: if it looks like "NEFT/CODE/TAIL" or "IMPS/CODE/TAIL", return ONLY the middle token (e.g. "NEFT/INDBH01093431022/SEAT" -> "INDBH01093431022"). Return the raw digits/code without the NEFT/ prefix or trailing suffix.
- If the email does NOT appear to be a payment/transaction notification, set all fields to null and confidence to "low"`,
        },
        { role: 'user', content: textToAnalyze },
      ],
      model: GROQ_CHAT_MODEL,
      max_tokens: 200,
      temperature: 0.1,
    });

    const response = completion.choices[0]?.message?.content?.trim() || '';
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    if (error.message?.includes('429') || error.status === 429) {
      console.warn('Groq rate limited, waiting 5s...');
      await new Promise(r => setTimeout(r, 5000));
      try {
        const completion = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: 'Extract payment details as JSON: {amount, payment_id, transaction_date, sender_name, payment_source, confidence}' },
            { role: 'user', content: textToAnalyze },
          ],
          model: GROQ_CHAT_MODEL,
          max_tokens: 200,
          temperature: 0.1,
        });
        const response = completion.choices[0]?.message?.content?.trim() || '';
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
      } catch { return null; }
    }
    return null;
  }
}

async function pollSingleAccount(account, sources, fromDate, includeSeen, onlySeenSkipped) {
  const config = {
    host: account.imap_host || 'imap.gmail.com',
    port: account.imap_port || 993,
    secure: true,
    auth: { user: account.email, pass: account.app_password },
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  };

  const client = new ImapFlow(config);
  let processed = 0;
  let skipped = 0;

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');
    console.log(`[emailImporter] ${account.name}: mailbox opened, total=${mailbox.exists}, recent=${mailbox.recent}`);

    let messages;
    try {
      messages = await client.search({ seen: false });
      console.log(`[emailImporter] ${account.name}: unseen found: ${messages?.length}`);
      if (!messages || messages.length === 0) {
        messages = await client.search({ seen: true });
        console.log(`[emailImporter] ${account.name}: seen found: ${messages?.length}`);
      }
    } catch (searchErr) {
      console.error(`[emailImporter] ${account.name}: search failed:`, searchErr.message);
      messages = [];
    }
    if (!messages || messages.length === 0) {
      await client.logout();
      return { processed: 0, skipped: 0, error: null, message: `No emails found (mailbox has ${mailbox.exists} total)` };
    }
    if (messages.length > 10) {
      messages = messages.slice(0, 10);
      console.log(`[emailImporter] ${account.name}: limiting to 10 messages`);
    }

      for await (const msg of client.fetch(messages, { source: true })) {
      try {
        const msgSeen = msg.flags?.includes('\\Seen') || false;
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || msg.uid?.toString();
        if (!messageId) { skipped++; continue; }

        const existing = await isEmailProcessed(messageId);
        if (existing) { skipped++; continue; }

        // Skip seen emails unless includeSeen is true or onlySeenSkipped is true
        if (msgSeen && !includeSeen && !onlySeenSkipped) {
          await logImport({
            email_message_id: messageId,
            email_subject: parsed.subject || '',
            email_from: parsed.from?.text || '',
            received_at: parsed.date || new Date().toISOString(),
            status: 'seen',
            seen: true,
            account_id: account.id,
            account_name: account.name,
          });
          skipped++;
          continue;
        }

        const emailSubject = parsed.subject || '';
        const emailFrom = parsed.from?.text || '';
        const emailText = parsed.text || parsed.html || '';
        const receivedAt = parsed.date || new Date().toISOString();

        const senderSource = detectSourceFromSender(emailFrom);
        if (senderSource === 'Razorpay') {
          await logImport({
            email_message_id: messageId,
            email_subject: emailSubject,
            email_from: emailFrom,
            received_at: receivedAt,
            status: 'skipped',
            error_message: 'Razorpay payment - ignored',
            raw_snippet: emailText.slice(0, 500),
            account_id: account.id,
            account_name: account.name,
          });
          skipped++;
          continue;
        }
        const details = await extractPaymentDetails(emailText, emailSubject, emailFrom);

if (details && details.confidence !== 'low' && details.amount != null) {
          let sourceName = details.payment_source;
          if (!sourceName && senderSource) sourceName = senderSource;

          // Deterministic overrides for bank-alert emails:
          // - The reference is usually wrapped like "NEFT/INDBH01093431022/SEAT"
          //   where the usable payment id is only the middle token.
          // - A bank credit alert carries no real sender person, so the payer is
          //   the bank account that issued the alert.
          const bankAlert = isBankSource(sourceName || senderSource);
          if (details.payment_id != null) details.payment_id = cleanPaymentId(details.payment_id);
          if (bankAlert) details.sender_name = sourceName || senderSource || details.sender_name;

          let sourceId = sourceName ? await getOrCreateSourceId(sources, sourceName) : null;
          const paymentSource = sourceName || senderSource || 'Google Pay';

          const transactionDate = details.transaction_date
            ? details.transaction_date
            : receivedAt ? receivedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

          // Dedup: a UPI/payment reference is unique to one transaction. If the
          // same reference already exists as a bank entry (a re-sent email) or
          // as a receipt (uploaded money), creating another entry would double
          // count it in the audit — skip and record the duplicate instead.
          const paymentId = details.payment_id ? String(details.payment_id).trim() : null;
          if (paymentId) {
            let alreadyKnown = false;
            try {
              const { rows } = await db._pool.query(
                `SELECT 1 FROM bank_audit_entries WHERE upper(trim(coalesce(payment_id, ''))) = upper($1) LIMIT 1`,
                [paymentId]
              );
              if (rows?.length > 0) alreadyKnown = true;
              else {
                const { rows: rcpt } = await db._pool.query(
                  `SELECT 1 FROM receipts WHERE upper(trim(coalesce(payment_id, ''))) = upper($1) LIMIT 1`,
                  [paymentId]
                );
                if (rcpt?.length > 0) alreadyKnown = true;
              }
            } catch (e) { console.error('Email import dedup check failed:', e.message); }
            if (alreadyKnown) {
              await logImport({
                email_message_id: messageId,
                email_subject: emailSubject,
                email_from: emailFrom,
                received_at: receivedAt,
                parsed_amount: details.amount,
                parsed_payment_id: details.payment_id,
                parsed_transaction_date: transactionDate,
                parsed_source: paymentSource,
                parsed_sender_name: details.sender_name,
                status: 'duplicate',
                seen: msgSeen,
                raw_snippet: emailText.slice(0, 500),
                account_id: account.id,
                account_name: account.name,
              });
              skipped++;
              continue;
            }
          }

          const entry = await createEntry({
            source_id: sourceId || 1,
            amount: details.amount,
            payment_id: details.payment_id || null,
            payer_name: details.sender_name || null,
            transaction_date: transactionDate,
            remarks: `[${account.name}] Auto-imported from email: ${emailSubject}`,
            created_by: null,
          });

          await logImport({
            email_message_id: messageId,
            email_subject: emailSubject,
            email_from: emailFrom,
            received_at: receivedAt,
            parsed_amount: details.amount,
            parsed_payment_id: details.payment_id,
            parsed_transaction_date: transactionDate,
            parsed_source: paymentSource,
            parsed_sender_name: details.sender_name,
            bank_entry_id: entry.id,
            status: 'imported',
            seen: msgSeen,
            raw_snippet: emailText.slice(0, 500),
            account_id: account.id,
            account_name: account.name,
          });

          if (!msgSeen) {
            try { await client.messageFlagsAdd(msg.uid, ['\\Seen']); } catch {}
          }
          processed++;
        } else {
          await logImport({
            email_message_id: messageId,
            email_subject: emailSubject,
            email_from: emailFrom,
            received_at: receivedAt,
            status: 'skipped',
            error_message: senderSource ? `Bank alert (${senderSource}) but no amount found` : (details ? 'Low confidence or no payment data' : 'Failed to parse'),
            raw_snippet: emailText.slice(0, 500),
            account_id: account.id,
            account_name: account.name,
          });
          skipped++;
        }
      } catch (msgError) {
        console.error(`[emailImporter] ${account.name}: message error:`, msgError.message);
        skipped++;
      }
    }

    await client.logout();
    await updateLastPolled(account.id);
    return { processed, skipped, error: null, message: `${processed} imported, ${skipped} skipped` };
  } catch (error) {
    try { await client.logout(); } catch {}
    return { processed, skipped, error: error.message, message: `IMAP error: ${error.message}` };
  }
}

export async function pollEmailInbox(fromDate, includeSeen) {
  const accounts = await getActiveAccounts();

  if (!accounts || accounts.length === 0) {
    if (emailConfig.enabled && emailConfig.imap.auth.user && emailConfig.imap.auth.pass) {
      accounts.push({
        id: null,
        name: 'Default',
        email: emailConfig.imap.auth.user,
        app_password: emailConfig.imap.auth.pass,
        imap_host: emailConfig.imap.host,
        imap_port: emailConfig.imap.port,
      });
    } else {
      lastPollResult = { success: null, message: 'No email accounts configured. Add one in Email Import settings.', count: 0, timestamp: new Date().toISOString(), error: null };
      return lastPollResult;
    }
  }

  const sources = await getSources();
  if (!sources || sources.length === 0) {
    console.warn('[emailImporter] No bank audit sources found');
  }

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const details = [];

  for (const account of accounts) {
    console.log(`[emailImporter] Polling ${account.name} (${account.email})...`);
    const result = await pollSingleAccount(account, sources, fromDate, includeSeen);
    totalProcessed += result.processed;
    totalSkipped += result.skipped;
    if (result.error) totalErrors++;
    details.push({ name: account.email, result });
  }

  lastPollResult = {
    success: totalErrors === 0,
    message: `Accounts: ${accounts.length} | Imported: ${totalProcessed} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`,
    count: totalProcessed,
    timestamp: new Date().toISOString(),
    error: totalErrors > 0 ? `${totalErrors} account(s) had errors` : null,
    details,
  };
  return lastPollResult;
}

export function getLastPollResult() {
  return lastPollResult;
}
