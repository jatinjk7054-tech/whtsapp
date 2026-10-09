import db from '../config/db.js';
import { getAccountByProject } from '../models/whatsappAccountModel.js';
import config from '../config/whatsappConfig.js';

const TIME_BUDGET_MS = 220000;

function normalizePhone(phone) {
  const raw = String(phone).replace(/[^0-9]/g, '');
  if (raw.length === 10) return '91' + raw;
  if (raw.length === 12 && raw.startsWith('91')) return raw;
  return raw;
}

async function resolveAudience(audience = {}) {
  const phoneSet = new Map();

  if (Array.isArray(audience.phones) && audience.phones.length > 0) {
    for (const p of audience.phones) {
      const norm = normalizePhone(p);
      if (norm) phoneSet.set(norm, null);
    }
  }

  if (Array.isArray(audience.contact_ids) && audience.contact_ids.length > 0) {
    const { data } = await db
      .from('contacts')
      .select('id, phone_normalized')
      .in('id', audience.contact_ids);
    for (const c of data || []) phoneSet.set(normalizePhone(c.phone_normalized), c.id);
  }

  if (audience.source || audience.project || audience.all) {
    let query = db.from('contacts').select('id, phone_normalized').limit(50000);
    if (audience.source) query = query.eq('source', audience.source);
    if (audience.project) query = query.eq('project', audience.project);
    const { data } = await query;
    for (const c of data || []) phoneSet.set(normalizePhone(c.phone_normalized), c.id);
  }

  return [...phoneSet.entries()].map(([phone, contactId]) => ({ phone, contactId }));
}

export async function createBroadcast({ name, accountProject, templateName, templateLanguage, bodyParams, audience, ratePerSecond, createdBy }) {
  if (!name || !accountProject || !templateName) {
    throw new Error('name, account_project and template_name are required');
  }
  const account = await getAccountByProject(accountProject);
  if (!account) throw new Error(`No active WhatsApp account for project "${accountProject}"`);

  const recipients = await resolveAudience(audience);
  if (recipients.length === 0) throw new Error('Audience resolved to 0 recipients');

  const { data: broadcast, error } = await db
    .from('whatsapp_broadcasts')
    .insert({
      name,
      account_project: accountProject,
      template_name: templateName,
      template_language: templateLanguage || account.template_language || 'en',
      body_params: bodyParams || [],
      audience: audience || {},
      status: 'draft',
      total_count: recipients.length,
      rate_per_second: Math.max(1, Math.min(20, parseInt(ratePerSecond, 10) || 5)),
      created_by: createdBy ? String(createdBy) : null,
    })
    .select()
    .single();
  if (error) throw error;

  const rows = recipients.map((r) => ({
    broadcast_id: broadcast.id,
    contact_id: r.contactId,
    phone: r.phone,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: rcptErr } = await db.from('whatsapp_broadcast_recipients').insert(rows.slice(i, i + 500));
    if (rcptErr) throw rcptErr;
  }

  return broadcast;
}

export async function listBroadcasts() {
  const { data, error } = await db
    .from('whatsapp_broadcasts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

export async function getBroadcast(id) {
  const { data: broadcast, error } = await db
    .from('whatsapp_broadcasts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  const { data: recipients } = await db
    .from('whatsapp_broadcast_recipients')
    .select('*')
    .eq('broadcast_id', id)
    .order('id', { ascending: true })
    .limit(1000);
  return { ...broadcast, recipients: recipients || [] };
}

export async function setBroadcastStatus(id, status) {
  const patch = { status };
  if (status === 'running') patch.started_at = new Date().toISOString();
  if (status === 'completed') patch.completed_at = new Date().toISOString();
  const { data, error } = await db.from('whatsapp_broadcasts').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function startBroadcast(id) {
  const { data: broadcast } = await db.from('whatsapp_broadcasts').select('*').eq('id', id).single();
  if (!broadcast) throw new Error('Broadcast not found');
  if (!['draft', 'paused'].includes(broadcast.status)) {
    throw new Error(`Cannot start broadcast in status "${broadcast.status}"`);
  }
  await setBroadcastStatus(id, 'running');
  processBroadcast(id).catch((err) => console.error(`[broadcast ${id}] processing error:`, err.message));
  return { ...broadcast, status: 'running' };
}

export async function pauseBroadcast(id) {
  return setBroadcastStatus(id, 'paused');
}

export async function cancelBroadcast(id) {
  return setBroadcastStatus(id, 'cancelled');
}

function renderParam(template, contactName) {
  return String(template ?? '')
    .replace(/\{\{\s*name\s*\}\}/gi, contactName || 'Donor')
    .trim();
}

async function sendBatch(broadcast, recipients) {
  const account = await getAccountByProject(broadcast.account_project);
  const accessToken = account?.access_token || config.accessToken;
  const phoneNumberId = account?.phone_number_id || config.phoneNumberId;
  if (!accessToken || !phoneNumberId) throw new Error(`WhatsApp account not configured for project "${broadcast.account_project}"`);

  const contactIds = recipients.map((r) => r.contact_id).filter(Boolean);
  const nameById = new Map();
  if (contactIds.length > 0) {
    const { data: contacts } = await db
      .from('contacts')
      .select('id, wa_profile_name')
      .in('id', contactIds);
    for (const c of contacts || []) nameById.set(c.id, c.wa_profile_name);
  }

  const delayMs = Math.max(60, Math.floor(1000 / (broadcast.rate_per_second || 5)));
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const { data: current } = await db
      .from('whatsapp_broadcasts')
      .select('status')
      .eq('id', broadcast.id)
      .single();
    if (!current || !['running'].includes(current.status)) break;

    const params = (broadcast.body_params || []).map((p) => ({
      type: 'text',
      text: renderParam(typeof p === 'string' ? p : p?.text, nameById.get(recipient.contact_id)),
    }));

    const body = {
      messaging_product: 'whatsapp',
      to: recipient.phone,
      type: 'template',
      template: {
        name: broadcast.template_name,
        language: { code: broadcast.template_language || 'en' },
        ...(params.length > 0 ? { components: [{ type: 'body', parameters: params }] } : {}),
      },
    };

    try {
      const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();

      if (response.ok && result.messages?.[0]?.id) {
        await db
          .from('whatsapp_broadcast_recipients')
          .update({
            wa_message_id: result.messages[0].id,
            status: 'sent',
            sent_at: new Date().toISOString(),
            status_updated_at: new Date().toISOString(),
          })
          .eq('id', recipient.id);
        await db._pool.query('UPDATE whatsapp_broadcasts SET sent_count = sent_count + 1 WHERE id = $1', [broadcast.id]);
        sent++;
      } else {
        await db
          .from('whatsapp_broadcast_recipients')
          .update({
            status: 'failed',
            failure_reason: result.error?.message || 'Meta API error',
            status_updated_at: new Date().toISOString(),
          })
          .eq('id', recipient.id);
        await db._pool.query('UPDATE whatsapp_broadcasts SET failed_count = failed_count + 1 WHERE id = $1', [broadcast.id]);
        failed++;
      }
    } catch (err) {
      await db
        .from('whatsapp_broadcast_recipients')
        .update({ status: 'failed', failure_reason: err.message, status_updated_at: new Date().toISOString() })
        .eq('id', recipient.id);
      await db._pool.query('UPDATE whatsapp_broadcasts SET failed_count = failed_count + 1 WHERE id = $1', [broadcast.id]);
      failed++;
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  return { sent, failed };
}

export async function processBroadcast(id) {
  const startedAt = Date.now();
  for (;;) {
    const { data: broadcast } = await db.from('whatsapp_broadcasts').select('*').eq('id', id).single();
    if (!broadcast || broadcast.status !== 'running') return { done: true };

    const { data: pending } = await db
      .from('whatsapp_broadcast_recipients')
      .select('*')
      .eq('broadcast_id', id)
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .limit(50);

    if (!pending || pending.length === 0) {
      await setBroadcastStatus(id, 'completed');
      return { done: true };
    }

    await sendBatch(broadcast, pending);

    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      return { done: false, message: 'Time budget reached — polling this endpoint continues the broadcast' };
    }
  }
}

export async function tickBroadcast(id) {
  const { data: broadcast } = await db.from('whatsapp_broadcasts').select('status').eq('id', id).single();
  if (!broadcast) throw new Error('Broadcast not found');
  if (broadcast.status !== 'running') return { running: false };
  processBroadcast(id).catch((err) => console.error(`[broadcast ${id}] tick error:`, err.message));
  return { running: true };
}
