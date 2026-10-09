import db from '../config/db.js';
import {
  getHrAccountStatus,
  HrWhatsAppError,
  isWithinServiceWindow,
  normalizeHrPhone,
  resolveHrAccount,
  sendHrLetterPdf,
  sendHrText,
  wrapMetaError,
} from '../services/hrWhatsAppService.js';
import { createSendLog, listSends } from '../models/hrWhatsAppSendModel.js';

// The recipient is looked up by the worker the HR user picked, not taken from
// the request body. The page keys volunteers by name, so the client sends the
// name it already has; taking a phone number from the request instead would let
// any HR user aim a warning letter at an arbitrary number.

const resolveRecipient = async (workerId, workerName) => {
  const query = db.from('workers').select('id, name, phone').limit(1);
  if (workerId) query.eq('id', workerId);
  else if (workerName) query.eq('name', workerName);
  else return null;
  const { data, error } = await query;
  if (error) throw error;
  return (data || [])[0] || null;
};

function requireRecipient(recipient) {
  if (!recipient) {
    throw new HrWhatsAppError('That volunteer was not found.', { code: 'hr_worker_missing', status: 404 });
  }
  if (!normalizeHrPhone(recipient.phone)) {
    throw new HrWhatsAppError(
      `${recipient.name} has no usable phone number on record. Add one under Workers before sending.`,
      { code: 'hr_phone_missing', status: 400 }
    );
  }
  return recipient;
}

const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);

// Every send is logged, including the failures. A send that Meta rejected is the
// row HR most needs to find, so the log is written on both paths and a log
// failure is only ever logged, never turned into a send failure — the volunteer
// already has the message.
async function logSend(row) {
  try {
    return await createSendLog(row);
  } catch (error) {
    console.error('[hr-whatsapp] could not write the send log:', error.message);
    return null;
  }
}

export async function accountStatus(req, res) {
  const status = await getHrAccountStatus();
  return res.json(status);
}

export async function sendText(req, res) {
  const { worker_id, worker_name, message_key, text } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ message: 'Message text is required' });
  }

  let account;
  let recipient;
  try {
    account = await resolveHrAccount();
    recipient = requireRecipient(await resolveRecipient(worker_id, worker_name));
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message, code: error.code });
  }

  try {
    const result = await sendHrText(recipient.phone, String(text), account);
    const log = await logSend({
      worker_id: recipient.id,
      worker_name: recipient.name,
      channel: 'text',
      message_key: message_key || null,
      body_preview: preview(text),
      to_phone: normalizeHrPhone(recipient.phone),
      whatsapp_account_id: account.id,
      wa_message_id: result.waMessageId,
      send_mode: result.mode,
      status: 'sent',
      sent_by: req.user?.id ? String(req.user.id) : null,
    });
    return res.json({ success: true, send_mode: result.mode, wa_message_id: result.waMessageId, log });
  } catch (error) {
    const wrapped = wrapMetaError(error);
    await logSend({
      worker_id: recipient.id,
      worker_name: recipient.name,
      channel: 'text',
      message_key: message_key || null,
      body_preview: preview(text),
      to_phone: normalizeHrPhone(recipient.phone),
      whatsapp_account_id: account.id,
      send_mode: null,
      status: 'failed',
      error_message: wrapped.message,
      sent_by: req.user?.id ? String(req.user.id) : null,
    });
    return res.status(wrapped.status || 500).json({ message: wrapped.message, code: wrapped.code });
  }
}

export async function sendLetter(req, res) {
  const { worker_id, worker_name, letter_type, pdf_base64, caption } = req.body || {};
  if (!pdf_base64) {
    return res.status(400).json({ message: 'The letter PDF is required' });
  }

  let account;
  let recipient;
  try {
    account = await resolveHrAccount();
    recipient = requireRecipient(await resolveRecipient(worker_id, worker_name));
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message, code: error.code });
  }

  try {
    const result = await sendHrLetterPdf(
      recipient.phone,
      { pdfBase64: pdf_base64, letterType: letter_type, workerName: recipient.name, caption },
      account
    );
    const log = await logSend({
      worker_id: recipient.id,
      worker_name: recipient.name,
      channel: 'document',
      letter_type: letter_type || null,
      body_preview: preview(caption || letter_type),
      to_phone: normalizeHrPhone(recipient.phone),
      whatsapp_account_id: account.id,
      wa_message_id: result.waMessageId,
      send_mode: result.mode,
      status: 'sent',
      sent_by: req.user?.id ? String(req.user.id) : null,
    });
    return res.json({
      success: true,
      send_mode: result.mode,
      wa_message_id: result.waMessageId,
      document_url: result.documentUrl,
      filename: result.filename,
      log,
    });
  } catch (error) {
    const wrapped = wrapMetaError(error);
    await logSend({
      worker_id: recipient.id,
      worker_name: recipient.name,
      channel: 'document',
      letter_type: letter_type || null,
      body_preview: preview(caption || letter_type),
      to_phone: normalizeHrPhone(recipient.phone),
      whatsapp_account_id: account.id,
      send_mode: null,
      status: 'failed',
      error_message: wrapped.message,
      sent_by: req.user?.id ? String(req.user.id) : null,
    });
    return res.status(wrapped.status || 500).json({ message: wrapped.message, code: wrapped.code });
  }
}

export async function history(req, res) {
  try {
    const sends = await listSends({ worker_id: req.query.worker_id, limit: req.query.limit });
    return res.json(sends);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

// Lets the page show, before HR presses anything, whether a given volunteer is
// inside the 24-hour window — which decides if the send can go out free-form.
export async function serviceWindow(req, res) {
  try {
    const account = await resolveHrAccount();
    const { withinWindow, lastInboundAt } = await isWithinServiceWindow(req.query.phone, account.id);
    return res.json({ within_window: withinWindow, last_inbound_at: lastInboundAt });
  } catch (error) {
    const wrapped = wrapMetaError(error);
    return res.status(wrapped.status || 500).json({ message: wrapped.message, code: wrapped.code });
  }
}
