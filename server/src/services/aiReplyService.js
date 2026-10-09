import db from '../config/db.js';
import groq, { GROQ_CHAT_MODEL } from '../config/groq.js';
import { getAccountByProject } from '../models/whatsappAccountModel.js';
import config from '../config/whatsappConfig.js';

const AI_MODEL = GROQ_CHAT_MODEL;
const TRANSCRIPT_LIMIT = 12;

function normalizePhone(phone) {
  const raw = String(phone).replace(/[^0-9]/g, '');
  if (raw.length === 10) return '91' + raw;
  if (raw.length === 12 && raw.startsWith('91')) return raw;
  return raw;
}

export async function getSettings(accountProject) {
  const { data } = await db
    .from('whatsapp_ai_settings')
    .select('*')
    .eq('account_project', accountProject)
    .maybeSingle();
  return (
    data || {
      account_project: accountProject,
      enabled: false,
      mode: 'suggest',
      system_prompt: null,
      knowledge_base: null,
      max_auto_replies: 3,
    }
  );
}

export async function upsertSettings(accountProject, updates) {
  const allowed = {};
  if (updates.enabled !== undefined) allowed.enabled = !!updates.enabled;
  if (updates.mode !== undefined) {
    if (!['auto', 'suggest'].includes(updates.mode)) throw new Error('mode must be "auto" or "suggest"');
    allowed.mode = updates.mode;
  }
  if (updates.system_prompt !== undefined) allowed.system_prompt = updates.system_prompt || null;
  if (updates.knowledge_base !== undefined) allowed.knowledge_base = updates.knowledge_base || null;
  if (updates.max_auto_replies !== undefined) {
    allowed.max_auto_replies = Math.max(0, Math.min(10, parseInt(updates.max_auto_replies, 10) || 3));
  }

  const { data: existing } = await db
    .from('whatsapp_ai_settings')
    .select('id')
    .eq('account_project', accountProject)
    .maybeSingle();

  if (existing) {
    if (Object.keys(allowed).length === 0) return getSettings(accountProject);
    const { data, error } = await db
      .from('whatsapp_ai_settings')
      .update({ ...allowed, updated_at: new Date().toISOString() })
      .eq('account_project', accountProject)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from('whatsapp_ai_settings')
    .insert({ account_project: accountProject, ...allowed })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function countConsecutiveAiReplies(conversationId) {
  const { data } = await db
    .from('messages')
    .select('direction, message_category, user_id')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(15);
  let count = 0;
  for (const m of data || []) {
    if (m.direction === 'outbound' && m.message_category === 'ai_reply') count++;
    else if (m.direction === 'outbound') break;
    else break;
  }
  return count;
}

async function buildTranscript(conversationId) {
  const { data } = await db
    .from('messages')
    .select('direction, body_text, message_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(TRANSCRIPT_LIMIT);
  return (data || [])
    .reverse()
    .map((m) => `${m.direction === 'inbound' ? 'Donor' : 'Agent'}: ${m.body_text || `[${m.message_type}]`}`)
    .join('\n');
}

export async function generateSuggestion({ conversation, contact, inboundText }) {
  const project = conversation.project || contact?.project || 'bsct';
  const settings = await getSettings(project);

  const transcript = await buildTranscript(conversation.id);
  const donorName = contact?.wa_profile_name || 'the donor';

  const systemParts = [
    `You are a polite, concise WhatsApp assistant for an NGO donation CRM. You are chatting with a donor named ${donorName}.`,
    'Reply with ONE short WhatsApp message (max 4 sentences). No markdown, no emojis unless the donor uses them, no quotes around your reply.',
    'If you cannot answer something (payments, refunds, personal data), politely say a team member will follow up.',
  ];
  if (settings.system_prompt) systemParts.push(settings.system_prompt);
  if (settings.knowledge_base) systemParts.push(`Organization knowledge you may use:\n${settings.knowledge_base}`);

  const completion = await groq.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemParts.join('\n') },
      { role: 'user', content: `Recent conversation:\n${transcript || `(new)\nDonor: ${inboundText}`}\n\nWrite the next agent reply.` },
    ],
    temperature: 0.4,
    max_tokens: 300,
  });

  return {
    text: (completion.choices[0]?.message?.content || '').trim(),
    model: AI_MODEL,
    settings,
  };
}

export async function handleInboundForAi({ conversation, contact, inboundMessage }) {
  try {
    const project = conversation.project || contact?.project || 'bsct';
    const settings = await getSettings(project);
    if (!settings.enabled) return;

    const inboundText =
      inboundMessage.body_text && !inboundMessage.body_text.startsWith('[')
        ? inboundMessage.body_text
        : null;
    if (!inboundText) return;

    const aiCount = await countConsecutiveAiReplies(conversation.id);
    if (aiCount >= (settings.max_auto_replies ?? 3)) return;

    const { text, model } = await generateSuggestion({ conversation, contact, inboundText });
    if (!text) return;

    if (settings.mode === 'suggest') {
      await db.from('whatsapp_ai_suggestions').insert({
        conversation_id: conversation.id,
        contact_id: conversation.contact_id,
        account_project: project,
        inbound_message_id: inboundMessage.id,
        suggestion_text: text,
        model,
      });
      return;
    }

    await sendAiReply(conversation, contact, text);
  } catch (err) {
    console.error('[aiReply] failed:', err.message);
  }
}

export async function sendAiReply(conversation, contact, text) {
  const project = conversation.project || contact?.project || 'bsct';
  const recipientPhone = normalizePhone(contact?.phone_normalized || contact?.phone);
  if (!recipientPhone) throw new Error('Recipient phone not found');

  let account = await getAccountByProject(project);
  const accessToken = account?.access_token || config.accessToken;
  const phoneNumberId = account?.phone_number_id || config.phoneNumberId;
  if (!accessToken || !phoneNumberId) {
    throw new Error(`WhatsApp account not configured for project "${project}"`);
  }

  const { data: message, error: msgErr } = await db
    .from('messages')
    .insert({
      tenant_id: conversation.tenant_id,
      conversation_id: conversation.id,
      contact_id: conversation.contact_id,
      user_id: 'ai-bot',
      direction: 'outbound',
      message_type: 'text',
      body_text: text,
      status: 'queued',
      message_category: 'ai_reply',
      is_automated: true,
    })
    .select()
    .single();
  if (msgErr) throw msgErr;

  const response = await fetch(
    `https://graph.facebook.com/${config.apiVersion}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  const result = await response.json();

  if (response.ok && result.messages?.[0]?.id) {
    await db
      .from('messages')
      .update({ wa_message_id: result.messages[0].id, status: 'sent', status_updated_at: new Date().toISOString() })
      .eq('id', message.id);
  } else {
    await db
      .from('messages')
      .update({
        status: 'failed',
        failure_reason: result.error?.message || 'Meta API error',
        status_updated_at: new Date().toISOString(),
      })
      .eq('id', message.id);
    throw new Error(result.error?.message || 'Failed to send AI reply');
  }

  await db
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversation.id);

  return message;
}
