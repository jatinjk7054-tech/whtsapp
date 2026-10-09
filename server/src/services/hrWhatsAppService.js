import db from '../config/db.js';
import whatsappConfig from '../config/whatsappConfig.js';
import { getAccountByProject } from '../models/whatsappAccountModel.js';
import { sendTextMessage, sendDocumentMessage } from './whatsappService.js';

// HR letters and warning messages go out from the "ucs" account in
// whatsapp_accounts (Ultimate Consultancy Services is the employing entity, so
// HR correspondence carries the UCS number rather than a beneficiary's).
//
// Meta's Cloud API only accepts a free-form message to a contact who has
// written to that number within the last 24 hours. Outside that window every
// send must use a pre-approved template, and with neither window nor template
// the send is impossible. So each send picks its branch:
//
//   inside 24h   -> free-form text / document      ('session')
//   outside      -> approved template              ('template')
//   no template  -> explicit error, no Meta call    (UI offers a wa.me link)
//
// The branch actually used comes back in `send_mode` and is stored in
// hr_whatsapp_sends, so it is always possible to tell after the fact why a given
// volunteer could or could not be reached.

const HR_ACCOUNT_PROJECT = 'ucs';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const LETTER_BUCKET = 'hr-letters';

export class HrWhatsAppError extends Error {
  constructor(message, { code = 'hr_whatsapp_error', status = 400, meta = null } = {}) {
    super(message);
    this.name = 'HrWhatsAppError';
    this.code = code;
    this.status = status;
    this.meta = meta;
  }
}

// Indian mobiles are stored inconsistently across this codebase (10 digits,
// 91-prefixed, with spaces or dashes, sometimes with a leading trunk 0). Meta
// wants country code + digits and nothing else, so normalise once here and
// reject anything not plausibly dialable rather than letting a bad value reach
// Meta and come back as an opaque error.
export function normalizeHrPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  if (digits.length < 11 || digits.length > 15) return '';
  return digits;
}

export function phoneVariants(phone) {
  const raw = normalizeHrPhone(phone);
  if (!raw) return [];
  const out = new Set([raw]);
  if (raw.length === 12 && raw.startsWith('91')) out.add(raw.slice(2));
  return [...out];
}

export async function resolveHrAccount() {
  const account = await getAccountByProject(HR_ACCOUNT_PROJECT);
  if (!account) {
    throw new HrWhatsAppError(
      'The UCS WhatsApp account is not active. Add or enable the "ucs" account under Accounts > WhatsApp.',
      { code: 'hr_account_missing', status: 503 }
    );
  }
  return account;
}

// Reports what the UI needs to decide whether to offer API sending at all: is
// the account there, and are the fallback templates named. Never returns the
// access token.
export async function getHrAccountStatus() {
  try {
    const account = await resolveHrAccount();
    return {
      ready: true,
      account: account.name,
      project: account.project,
      phone_number_id: account.phone_number_id,
      letter_template: account.hr_letter_template || null,
      warning_template: account.hr_warning_template || null,
    };
  } catch (error) {
    return { ready: false, error: error.message, letter_template: null, warning_template: null };
  }
}

// The webhook (/api/webhooks/whatsapp) writes conversations.last_inbound_at
// every time a contact messages in, so that column IS the window. Scoped to
// this account on purpose: the window is per sending number, so a volunteer who
// wrote to a different NGO's number does not open the UCS window.
//
// Tolerant by design. If the chat tables are missing or unreadable this reports
// "outside the window" rather than failing the send outright — the consequence
// is an attempted template send that Meta may reject, which is a far better
// outcome than refusing to send a warning letter at all.
export async function isWithinServiceWindow(phone, accountId) {
  const variants = phoneVariants(phone);
  if (!variants.length) return { withinWindow: false, lastInboundAt: null };

  try {
    const { data: contacts, error: contactError } = await db
      .from('contacts')
      .select('id')
      .in('phone_normalized', variants);
    if (contactError) throw contactError;
    if (!contacts?.length) return { withinWindow: false, lastInboundAt: null };

    const { data: conversations, error: convError } = await db
      .from('conversations')
      .select('id, last_inbound_at, whatsapp_account_id')
      .in('contact_id', contacts.map((c) => c.id))
      .not('last_inbound_at', 'is', null);
    if (convError) throw convError;
    if (!conversations?.length) return { withinWindow: false, lastInboundAt: null };

    const scoped = accountId
      ? conversations.filter((c) => String(c.whatsapp_account_id) === String(accountId))
      : [];
    // Fall back to any conversation only when none is attributed to this
    // account, so a mis-scoped row cannot wrongly deny a valid window.
    const pool = scoped.length ? scoped : conversations;
    // timestamptz arrives as an ISO string (db.js parses it that way).
    const last = pool
      .map((c) => new Date(c.last_inbound_at).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    if (last === undefined) return { withinWindow: false, lastInboundAt: null };

    return { withinWindow: Date.now() - last <= WINDOW_MS, lastInboundAt: new Date(last).toISOString() };
  } catch (error) {
    console.warn('[hr-whatsapp] could not read the 24h service window:', error.message);
    return { withinWindow: false, lastInboundAt: null };
  }
}

function metaMessageId(result) {
  return result?.messages?.[0]?.id || result?.data?.messages?.[0]?.id || null;
}

// Turns Meta's error text into something HR can act on. 131009 is the
// outside-the-window rejection, given its own code so the client can offer the
// wa.me deep link rather than just showing red text.
export function wrapMetaError(error) {
  if (error instanceof HrWhatsAppError) return error;
  const raw = String(error?.message || error || '');
  if (/131009/i.test(raw)) {
    return new HrWhatsAppError(
      'Meta rejected this send: the volunteer has not written to this number in the last 24 hours, so an approved template is required. Send it from WhatsApp manually instead.',
      { code: 'hr_outside_window', status: 409, meta: { metaError: raw } }
    );
  }
  return new HrWhatsAppError(`WhatsApp send failed: ${raw}`, {
    code: 'hr_send_failed',
    status: 502,
    meta: { metaError: raw },
  });
}

function requireTemplate(account, column, label) {
  const name = account?.[column];
  if (name) return name;
  throw new HrWhatsAppError(
    `No approved WhatsApp template is configured for ${label}, and this volunteer is outside the 24-hour window. Set the template name on the "ucs" WhatsApp account, or send it manually from WhatsApp.`,
    { code: 'hr_template_missing', status: 409 }
  );
}

// Single place that talks to Meta for the template branch. sendTemplateMessage
// in whatsappService cannot carry a document header, and the letter template
// needs one, so the raw call lives here rather than widening the shared
// service's signature, which the accounts/receipts flow also depends on.
async function sendViaGraph({ account, to, templateName, language, headerDocument, bodyText }) {
  const components = [];
  if (headerDocument) {
    components.push({
      type: 'header',
      parameters: [{ type: 'document', document: { link: headerDocument.link, filename: headerDocument.filename } }],
    });
  }
  components.push({ type: 'body', parameters: [{ type: 'text', text: String(bodyText) }] });

  const res = await fetch(
    `https://graph.facebook.com/${whatsappConfig.apiVersion}/${account.phone_number_id}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(to).replace(/[^0-9]/g, ''),
        type: 'template',
        template: { name: templateName, language: { code: language || 'en' }, components },
      }),
    }
  );
  const raw = await res.text();
  if (!res.ok) throw wrapMetaError(new Error(raw));
  return JSON.parse(raw);
}

export async function sendHrText(phone, text, account) {
  const to = normalizeHrPhone(phone);
  if (!to) {
    throw new HrWhatsAppError('That volunteer has no usable phone number on record.', {
      code: 'hr_phone_missing',
      status: 400,
    });
  }

  const { withinWindow } = await isWithinServiceWindow(phone, account?.id);
  if (withinWindow) {
    const result = await sendTextMessage(to, text, account);
    return { mode: 'session', waMessageId: metaMessageId(result) };
  }

  // An approved template's body text is fixed, so the entire message is passed
  // as the single {{1}} body parameter the template must declare.
  const templateName = requireTemplate(account, 'hr_warning_template', 'warning messages');
  const result = await sendViaGraph({
    account,
    to,
    templateName,
    language: account?.template_language,
    bodyText: text,
  });
  return { mode: 'template', waMessageId: metaMessageId(result) };
}

// Meta fetches document links itself, so the PDF must be reachable by public
// URL. Uploaded once, then referenced by whichever branch runs.
async function uploadLetterPdf({ pdfBase64, letterType, workerName }) {
  const buffer = Buffer.from(pdfBase64 || '', 'base64');
  if (!buffer.length) {
    throw new HrWhatsAppError('The letter PDF came back empty.', { code: 'hr_pdf_empty', status: 400 });
  }

  const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const label = `${safe(letterType) || 'Letter'}_${safe(workerName) || 'Volunteer'}`;
  const filename = `${label}.pdf`;
  const storagePath = `${new Date().getFullYear()}/${label}_${Date.now()}.pdf`;

  let { error } = await db.storage
    .from(LETTER_BUCKET)
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (error) {
    // Created on first use, mirroring the receipts bucket.
    await db.storage.createBucket(LETTER_BUCKET, { public: true });
    const retry = await db.storage
      .from(LETTER_BUCKET)
      .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
    error = retry.error;
  }
  if (error) {
    throw new HrWhatsAppError(`Could not store the letter PDF: ${error.message}`, {
      code: 'hr_pdf_upload_failed',
      status: 502,
    });
  }

  const { data } = db.storage.from(LETTER_BUCKET).getPublicUrl(storagePath);
  const url = data?.publicUrl;
  if (!url) {
    throw new HrWhatsAppError('The letter PDF was stored but no public URL was returned.', {
      code: 'hr_pdf_upload_failed',
      status: 502,
    });
  }
  return { url, filename };
}

export async function sendHrLetterPdf(phone, { pdfBase64, letterType, workerName, caption }, account) {
  const to = normalizeHrPhone(phone);
  if (!to) {
    throw new HrWhatsAppError('That volunteer has no usable phone number on record.', {
      code: 'hr_phone_missing',
      status: 400,
    });
  }

  const { url, filename } = await uploadLetterPdf({ pdfBase64, letterType, workerName });
  const body = caption || '';

  const { withinWindow } = await isWithinServiceWindow(phone, account?.id);
  if (withinWindow) {
    const result = await sendDocumentMessage(to, url, body, filename, account);
    return { mode: 'session', waMessageId: metaMessageId(result), documentUrl: url, filename };
  }

  // Outside the window the PDF has to ride in as a template header, so the
  // template must declare a DOCUMENT header plus a {{1}} body placeholder.
  const templateName = requireTemplate(account, 'hr_letter_template', 'letters');
  const result = await sendViaGraph({
    account,
    to,
    templateName,
    language: account?.template_language,
    headerDocument: { link: url, filename },
    bodyText: body || filename,
  });
  return { mode: 'template', waMessageId: metaMessageId(result), documentUrl: url, filename };
}
