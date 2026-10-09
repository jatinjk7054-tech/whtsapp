import { pollEmailInbox, getLastPollResult } from '../services/emailImporter.js';
import { getImportLog, countByStatus, logImport } from '../models/emailImportLogModel.js';
import db from '../config/db.js';

export async function triggerImport(req, res) {
  try {
    const fromDate = req.query.fromDate || null;
    const includeSeen = req.query.includeSeen === 'true';
    const result = await pollEmailInbox(fromDate, includeSeen);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function processSeenEmails(req, res) {
  try {
    const result = await pollEmailInbox(null, true);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

export async function testEmail(req, res) {
  try {
    const { data: sources } = await db.from('bank_audit_sources').select('id, name').limit(1);
    const sourceId = sources?.[0]?.id || null;

    const { data: entry } = await db.from('bank_audit_entries').insert({
      source_id: sourceId || 1,
      amount: 1500.00,
      payment_id: 'TESTUPI123456',
      transaction_date: new Date().toISOString().slice(0, 10),
      remarks: '[Test] Auto-imported from test email: Your account has been credited with ₹1,500',
      created_by: null,
    }).select().single();

    await logImport({
      email_message_id: 'test-' + Date.now(),
      email_subject: 'Your account has been credited with ₹1,500',
      email_from: 'noreply@testbank.com',
      received_at: new Date().toISOString(),
      parsed_amount: 1500,
      parsed_payment_id: 'TESTUPI123456',
      parsed_transaction_date: new Date().toISOString().slice(0, 10),
      parsed_source: 'GPay',
      bank_entry_id: entry.id,
      status: 'imported',
      raw_snippet: 'Your account has been credited with ₹1,500 from Test Donor via UPI ref TESTUPI123456.',
      account_id: null,
      account_name: 'Test Account',
    });

    return res.json({ success: true, message: 'Test email created', entry_id: entry.id });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getImportStatus(req, res) {
  try {
    const lastPoll = getLastPollResult();
    const counts = await countByStatus();
    return res.json({ lastPoll, counts });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getLog(req, res) {
  try {
    const { status, account_id } = req.query;
    const log = await getImportLog({ status, account_id, limit: 100 });
    return res.json(log);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
