import db from '../config/db.js';
import {
  getSettings as getAiSettings,
  upsertSettings as upsertAiSettings,
  generateSuggestion,
  sendAiReply,
} from '../services/aiReplyService.js';
import {
  createBroadcast,
  listBroadcasts,
  getBroadcast,
  startBroadcast,
  pauseBroadcast,
  cancelBroadcast,
  tickBroadcast,
} from '../services/broadcastService.js';
import { syncTemplatesForProject } from '../services/templateSyncService.js';
import {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} from '../services/routingService.js';
import {
  getOverview,
  getDailyVolumes,
  getAgentPerformance,
  getBroadcastAnalytics,
} from '../services/analyticsService.js';
import { buildInteractivePayload } from '../services/whatsappService.js';
import { getAccountByProject } from '../models/whatsappAccountModel.js';
import config from '../config/whatsappConfig.js';

// ---- AI auto-reply (admin) ----

export async function aiSettingsGet(req, res) {
  try {
    res.json(await getAiSettings(req.params.project));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function aiSettingsPut(req, res) {
  try {
    const updated = await upsertAiSettings(req.params.project, req.body || {});
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function aiSuggestionsList(req, res) {
  try {
    let query = db
      .from('whatsapp_ai_suggestions')
      .select('*, conversation:conversations!inner(id, project, contact_id, contact:contacts(id, phone_normalized, wa_profile_name))')
      .order('created_at', { ascending: false })
      .limit(100);
    if (req.query.status) query = query.eq('status', String(req.query.status));
    if (req.query.project) query = query.eq('conversation.project', String(req.query.project));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function aiSuggestionDecide(req, res) {
  try {
    const { id } = req.params;
    const action = req.body?.action;
    if (!['accepted', 'dismissed'].includes(action)) {
      return res.status(400).json({ message: 'action must be "accepted" or "dismissed"' });
    }

    const { data: suggestion, error } = await db
      .from('whatsapp_ai_suggestions')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !suggestion) return res.status(404).json({ message: 'Suggestion not found' });
    if (suggestion.status !== 'pending') return res.status(409).json({ message: `Suggestion already ${suggestion.status}` });

    await db
      .from('whatsapp_ai_suggestions')
      .update({
        status: action,
        decided_at: new Date().toISOString(),
        decided_by: String(req.user?.id || req.user?.sub || 'unknown'),
      })
      .eq('id', id);

    if (action === 'accepted') {
      const { data: conversation } = await db
        .from('conversations')
        .select('*, contact:contacts!inner(id, phone_normalized, phone, project)')
        .eq('id', suggestion.conversation_id)
        .single();
      if (!conversation) return res.status(404).json({ message: 'Conversation no longer exists' });
      const message = await sendAiReply(conversation, conversation.contact, suggestion.suggestion_text);
      return res.json({ ok: true, sent: true, message });
    }

    res.json({ ok: true, sent: false });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function aiPreview(req, res) {
  try {
    const { data: conversation } = await db
      .from('conversations')
      .select('*, contact:contacts!inner(id, phone_normalized, wa_profile_name, project)')
      .eq('id', req.params.conversationId)
      .single();
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    const result = await generateSuggestion({
      conversation,
      contact: conversation.contact,
      inboundText: req.body?.lastMessage || '',
    });
    res.json({ suggestion: result.text, model: result.model });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ---- Broadcasts ----

export async function broadcastCreate(req, res) {
  try {
    const b = req.body || {};
    const broadcast = await createBroadcast({
      name: b.name,
      accountProject: b.account_project || b.project,
      templateName: b.template_name,
      templateLanguage: b.template_language,
      bodyParams: b.body_params,
      audience: b.audience,
      ratePerSecond: b.rate_per_second,
      createdBy: req.user?.id || req.user?.sub,
    });
    res.status(201).json(broadcast);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function broadcastList(req, res) {
  try {
    res.json(await listBroadcasts());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function broadcastGet(req, res) {
  try {
    const broadcast = await getBroadcast(req.params.id);
    if (broadcast.status === 'running') tickBroadcast(broadcast.id).catch(() => {});
    res.json(broadcast);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function broadcastStart(req, res) {
  try {
    res.json(await startBroadcast(req.params.id));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function broadcastPause(req, res) {
  try {
    res.json(await pauseBroadcast(req.params.id));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function broadcastCancel(req, res) {
  try {
    res.json(await cancelBroadcast(req.params.id));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

// ---- Template sync ----

export async function templatesSync(req, res) {
  try {
    const project = req.body?.project || req.query.project;
    if (!project) return res.status(400).json({ message: 'project is required' });
    res.json(await syncTemplatesForProject(project));
  } catch (error) {
    res.status(502).json({ message: error.message });
  }
}

// ---- Routing rules ----

export async function routingRulesList(req, res) {
  try {
    res.json(await listRules(req.query.project));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function routingRulesCreate(req, res) {
  try {
    res.status(201).json(await createRule(req.body || {}));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function routingRulesUpdate(req, res) {
  try {
    res.json(await updateRule(req.params.id, req.body || {}));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

export async function routingRulesDelete(req, res) {
  try {
    await deleteRule(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ---- Analytics ----

export async function analyticsOverview(req, res) {
  try {
    res.json(
      await getOverview({
        project: req.query.project,
        days: req.query.days,
      })
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function analyticsDaily(req, res) {
  try {
    res.json(
      await getDailyVolumes({
        project: req.query.project,
        days: req.query.days,
      })
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function analyticsAgents(req, res) {
  try {
    res.json(
      await getAgentPerformance({
        project: req.query.project,
        days: req.query.days,
      })
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

export async function analyticsBroadcasts(req, res) {
  try {
    res.json(await getBroadcastAnalytics());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

// ---- Interactive messages (FRO chat) ----

export async function sendInteractive(req, res) {
  try {
    const { id } = req.params;
    const payload = req.body || {};

    const { data: conversation, error: convErr } = await db
      .from('conversations')
      .select('*, contact:contacts!inner(id, phone_normalized, phone, project)')
      .eq('id', id)
      .single();
    if (convErr || !conversation) return res.status(404).json({ message: 'Conversation not found' });

    const project = conversation.project || conversation.contact?.project || 'bsct';
    const recipientPhone = conversation.contact?.phone_normalized || conversation.contact?.phone;

    const interactive = buildInteractivePayload(payload);

    const { data: message, error: msgErr } = await db
      .from('messages')
      .insert({
        tenant_id: conversation.tenant_id,
        conversation_id: conversation.id,
        contact_id: conversation.contact_id,
        user_id: String(req.user?.id || req.user?.sub || 'unknown'),
        direction: 'outbound',
        message_type: 'interactive',
        body_text: interactive.body?.text || '',
        interactive_payload: interactive,
        status: 'queued',
        message_category: 'interactive',
      })
      .select()
      .single();
    if (msgErr) throw msgErr;

    const accountProject = project;
    const account = await getAccountByProject(accountProject);
    const accessToken = account?.access_token || config.accessToken;
    const phoneNumberId = account?.phone_number_id || config.phoneNumberId;
    if (!accessToken || !phoneNumberId) {
      throw new Error(`WhatsApp account not configured for project "${accountProject}"`);
    }

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
          type: 'interactive',
          interactive,
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
      return res.status(502).json({ message: result.error?.message || 'Failed to send interactive message' });
    }

    await db
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation.id);

    res.json({ ok: true, message: { ...message, status: 'sent' } });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}
