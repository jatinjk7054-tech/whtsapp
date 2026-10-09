import { sendTextMessage, sendTemplateMessage } from '../lib/whatsapp/client.js';
import {
  confirmOutboundMessage,
  failOutboundMessage,
  insertOutboundMessage,
} from '../conversations/message.repository.js';
import { touchConversation } from '../conversations/conversation.repository.js';
import { windowState } from '../conversations/messaging.policy.js';
import { addContactTags } from '../tags/tag.repository.js';
import { findMatchingRule } from './match.js';
import {
  claimKeywordReplyLog,
  claimRuleCooldown,
  finalizeAutomationLog,
  getAutomationSettings,
  insertAutomationLog,
  listEnabledRules,
  releaseRuleCooldown,
} from './automation.repository.js';

/**
 * Module 9 — the keyword-automation engine.
 *
 * `runAutomationForInbound` is called from handleInbound() only, i.e. for a
 * genuine customer message arriving through the webhook. Agent/Admin sends,
 * template sends, status updates and our own automated replies are all
 * outbound, so they can never re-enter this function — there is no reply loop.
 *
 * This module makes NO assignment decisions: it never writes
 * conversations.assigned_staff_id. Ownership stays exactly as Modules 1–8 left
 * it (manual claim / manual assign).
 */

/** Writes an automation log without ever breaking the reply flow. */
async function safeLog(entry) {
  try {
    return await insertAutomationLog(entry);
  } catch (error) {
    console.error('Automation log write failed:', error.message);
    return null;
  }
}

/** Applies the rule's optional customer tag. A failure is logged, not fatal. */
async function applyRuleTag(conversation, rule) {
  if (!rule.tag_id || !conversation.contact_id) return;
  try {
    await addContactTags(conversation.contact_id, [rule.tag_id]);
  } catch (error) {
    console.error('Applying automation rule tag failed:', error.message);
  }
}

async function sendTextReply({ conversation, rule, logId, summary }) {
  const body = String(rule.reply_text ?? '').trim();

  if (!body) {
    await releaseRuleCooldown(conversation.id, rule.id);
    await finalizeAutomationLog(logId, { result: 'skipped', detail: 'Rule reply text is empty' });
    summary.result = 'skipped';
    summary.reason = 'rule reply text is empty';
    return summary;
  }

  const messageId = await insertOutboundMessage({
    conversationId: conversation.id,
    sentByStaffId: null,
    type: 'text',
    body,
    mediaUrl: null,
  });

  try {
    const response = await sendTextMessage({ to: conversation.contact_wa_id, body });
    const waMessageId = response.messages?.[0]?.id ?? null;
    await confirmOutboundMessage(messageId, waMessageId);
    await touchConversation(conversation.id, body);
    await applyRuleTag(conversation, rule);
    await finalizeAutomationLog(logId, { result: 'sent', messageId, waMessageId });
    summary.sent = true;
    summary.result = 'sent';
    summary.messageId = messageId;
    return summary;
  } catch (error) {
    await failOutboundMessage(messageId, error.code, error.message);
    await releaseRuleCooldown(conversation.id, rule.id);
    await finalizeAutomationLog(logId, { result: 'failed', detail: error.message, messageId });
    summary.result = 'failed';
    summary.reason = `send failed: ${error.message}`;
    console.error('Keyword auto-reply failed:', error.message);
    return summary;
  }
}

async function sendTemplateReply({ conversation, rule, logId, summary }) {
  const label = `[Template] ${rule.template_name}`;
  const messageId = await insertOutboundMessage({
    conversationId: conversation.id,
    sentByStaffId: null,
    type: 'template',
    body: label,
    mediaUrl: null,
    templateName: rule.template_name,
    templateLanguage: rule.template_language,
  });

  try {
    const response = await sendTemplateMessage({
      to: conversation.contact_wa_id,
      template: { name: rule.template_name, language: rule.template_language },
    });
    const waMessageId = response.messages?.[0]?.id ?? null;
    await confirmOutboundMessage(messageId, waMessageId);
    await touchConversation(conversation.id, label);
    await applyRuleTag(conversation, rule);
    await finalizeAutomationLog(logId, { result: 'sent', messageId, waMessageId });
    summary.sent = true;
    summary.result = 'sent';
    summary.messageId = messageId;
    return summary;
  } catch (error) {
    await failOutboundMessage(messageId, error.code, error.message);
    await releaseRuleCooldown(conversation.id, rule.id);
    await finalizeAutomationLog(logId, { result: 'failed', detail: error.message, messageId });
    summary.result = 'failed';
    summary.reason = `template send failed: ${error.message}`;
    console.error('Keyword template auto-reply failed:', error.message);
    return summary;
  }
}

/**
 * Evaluates the enabled rules against one inbound message and, when a rule
 * matches, sends its reply. Returns a small summary so the caller (and tests)
 * can see exactly what happened. Never throws for a normal skip.
 *
 * @param {{ id:number, contact_id:number, contact_wa_id:string }} conversation
 * @param {{ id:number, body?:string }} inboundMessage
 * @param {{ awaySent?:boolean, now?:Date }} [options]
 */
export async function runAutomationForInbound(conversation, inboundMessage, { awaySent = false } = {}) {
  const summary = { ran: false, matched: false, sent: false, rule: null, result: null, reason: null };

  const settings = await getAutomationSettings();
  if (!settings.enabled) {
    summary.reason = 'Keyword automation is disabled';
    return summary;
  }

  // Default guard: a customer never receives both an Away Message and a keyword
  // reply for the same inbound unless the Admin explicitly opts in.
  if (awaySent && !settings.sendAwayAndKeyword) {
    summary.reason = 'An Away Message was already sent for this message';
    return summary;
  }

  const body = String(inboundMessage?.body ?? '').trim();
  if (!body) {
    summary.reason = 'Inbound message has no text to match';
    return summary;
  }

  const rules = await listEnabledRules();
  const rule = findMatchingRule(body, rules);
  if (!rule) {
    summary.reason = 'No keyword rule matched';
    return summary;
  }

  summary.ran = true;
  summary.matched = true;
  summary.rule = { id: rule.id, name: rule.name, matchType: rule.match_type };

  // Per-conversation cooldown: claim before anything is written or sent.
  if (!(await claimRuleCooldown(conversation.id, rule.id, rule.cooldown_seconds))) {
    summary.reason = 'Rule is in cooldown for this conversation';
    await safeLog({
      action: 'keyword_reply',
      result: 'skipped',
      conversationId: conversation.id,
      contactId: conversation.contact_id,
      triggerMessageId: inboundMessage.id,
      ruleId: rule.id,
      ruleName: rule.name,
      detail: summary.reason,
    });
    return summary;
  }

  // Idempotency backstop: one keyword reply per (inbound message, rule), so a
  // redelivered webhook cannot double-send.
  const logId = await claimKeywordReplyLog({
    conversationId: conversation.id,
    contactId: conversation.contact_id,
    triggerMessageId: inboundMessage.id,
    ruleId: rule.id,
    ruleName: rule.name,
  });

  if (!logId) {
    await releaseRuleCooldown(conversation.id, rule.id);
    summary.reason = 'This message was already answered for this rule';
    return summary;
  }

  const window = await windowState(conversation.id);

  // Outside the 24-hour window a free-form reply is forbidden; only a
  // configured approved template may be used, otherwise the attempt is blocked
  // and clearly recorded.
  if (!window.open) {
    if (!rule.template_name || !rule.template_language) {
      await releaseRuleCooldown(conversation.id, rule.id);
      await finalizeAutomationLog(logId, {
        result: 'blocked',
        detail: 'The 24-hour window is closed and the rule has no approved template',
      });
      summary.result = 'blocked';
      summary.reason = 'outside the 24-hour window and no template configured';
      return summary;
    }
    return sendTemplateReply({ conversation, rule, logId, summary });
  }

  return sendTextReply({ conversation, rule, logId, summary });
}

/**
 * Pure preview used by the Admin "Test rule" action and by tests. It performs
 * no writes and never sends anything: it only reports which rule would win and
 * the reply text that would go out.
 */
export async function previewAutomation(text, extraRules = null) {
  const rules = extraRules ?? (await listEnabledRules());
  const rule = findMatchingRule(text, rules);
  return {
    matched: Boolean(rule),
    rule: rule
      ? { id: rule.id, name: rule.name, keyword: rule.keyword, matchType: rule.match_type }
      : null,
    replyText: rule ? rule.reply_text : null,
    template: rule?.template_name
      ? { name: rule.template_name, language: rule.template_language }
      : null,
  };
}
