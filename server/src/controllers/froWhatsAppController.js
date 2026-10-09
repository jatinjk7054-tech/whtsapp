import {
  getFroConversations,
  getAgentConversations,
  getAgentUnreadCount,
  getConversationMessages,
  sendFroReply,
  sendDirectMessage,
  createEmptyConversation,
  markConversationRead,
  getFroUnreadCount,
  getQuickReplies,
  getTemplates,
  sendTemplateReply,
  searchFroMessages,
  updateConversationLabels,
  uploadFroMedia,
} from '../services/froWhatsAppService.js';
import { froActPairs } from './froController.js';
import db from '../config/db.js';
import config from '../config/whatsappConfig.js';

export async function getMedia(req, res) {
  try {
    const { mediaId } = req.params;
    if (!mediaId) return res.status(400).json({ message: 'mediaId is required' });

    let accessToken = null;
    const { data: message } = await db
      .from('messages')
      .select('conversation_id')
      .eq('media_id', mediaId)
      .limit(1)
      .maybeSingle();

    if (message?.conversation_id) {
      const { data: conversation } = await db
        .from('conversations')
        .select('project')
        .eq('id', message.conversation_id)
        .maybeSingle();
      if (conversation?.project) {
        const { data: account } = await db
          .from('whatsapp_accounts')
          .select('access_token')
          .eq('project', conversation.project)
          .eq('is_active', true)
          .maybeSingle();
        accessToken = account?.access_token;
      }
    }

    if (!accessToken) {
      const { data: anyAccount } = await db
        .from('whatsapp_accounts')
        .select('access_token')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      accessToken = anyAccount?.access_token;
    }

    if (!accessToken) return res.status(400).json({ message: 'No WhatsApp account configured' });

    const infoRes = await fetch(`https://graph.facebook.com/${config.apiVersion}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.url) {
      return res.status(infoRes.status || 500).json({ message: info.error?.message || 'Failed to resolve media' });
    }

    const dlRes = await fetch(info.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!dlRes.ok) return res.status(502).json({ message: 'Failed to download media' });

    const contentType = info.mime_type || dlRes.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const filename = info.filename || `media-${mediaId}`;
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.status(200);
    dlRes.body.pipe(res);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function listAgentConversations(req, res) {
  try {
    const { project } = req.query;
    const conversations = await getAgentConversations(req.user.id, project || null, req.user.role);
    return res.json(conversations);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function agentUnreadCount(req, res) {
  try {
    const count = await getAgentUnreadCount(req.user.id, req.user.role);
    return res.json({ count });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function listConversations(req, res) {
  try {
    const conversations = await getFroConversations(req.user.id, froActPairs(req));
    return res.json(conversations);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function listMessages(req, res) {
  try {
    const { id } = req.params;
    const messages = await getConversationMessages(id);
    return res.json(messages);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function sendMessage(req, res) {
  try {
    const { id } = req.params;
    const { text, mediaUrl } = req.body;

    if ((!text || !text.trim()) && !mediaUrl) {
      return res.status(400).json({ message: 'Message text or media URL is required' });
    }

    const message = await sendFroReply(id, req.user.id, text?.trim() || '', mediaUrl);
    return res.json({ success: true, message });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function sendDirect(req, res) {
  try {
    const { phone, text, project } = req.body;
    if (!phone || !text || !text.trim()) {
      return res.status(400).json({ message: 'Phone and text are required' });
    }

    const result = await sendDirectMessage(req.user.id, phone, text.trim(), project);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function createConversation(req, res) {
  try {
    const { phone, project } = req.body;
    if (!phone) {
      return res.status(400).json({ message: 'Phone is required' });
    }

    const result = await createEmptyConversation(req.user.id, phone, project || null);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function markRead(req, res) {
  try {
    const { id } = req.params;
    await markConversationRead(id, req.user.id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function unreadCount(req, res) {
  try {
    const count = await getFroUnreadCount(req.user.id);
    return res.json({ count });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function listQuickReplies(req, res) {
  try {
    const replies = await getQuickReplies();
    return res.json(replies);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function listTemplates(req, res) {
  try {
    const { project } = req.query;
    const templates = await getTemplates(project);
    return res.json(templates);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function sendTemplate(req, res) {
  try {
    const { conversationId, templateName, paramValues, headerMediaUrl, headerMediaName } = req.body;
    if (!conversationId || !templateName) {
      return res.status(400).json({ message: 'conversationId and templateName are required' });
    }
    const message = await sendTemplateReply(conversationId, req.user.id, templateName, paramValues || [], headerMediaUrl, headerMediaName);
    return res.json({ success: true, message });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function searchMessages(req, res) {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.json([]);
    }
    const results = await searchFroMessages(req.user.id, q.trim());
    return res.json(results);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function updateLabels(req, res) {
  try {
    const { id } = req.params;
    const { labels } = req.body;
    if (!Array.isArray(labels)) {
      return res.status(400).json({ message: 'labels must be an array' });
    }
    await updateConversationLabels(id, labels);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function uploadMedia(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const record = await uploadFroMedia(req.user.id, req.file);
    return res.json({ url: record.file_url, name: record.name, type: record.file_type });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function listMyAccounts(req, res) {
  try {
    const userId = req.user.id;
    const { data: froAssignments } = await db
      .from('fro_whatsapp_assignments')
      .select('whatsapp_accounts!inner(id, name, phone_number_id, project)')
      .eq('fro_worker_id', userId)
      .eq('is_active', true);

    const { data: crmAssignments } = await db
      .from('agent_phone_assignments')
      .select('whatsapp_accounts!inner(id, name, phone_number_id, project)')
      .eq('user_id', userId);

    const { data: workerAssignments } = await db
      .from('worker_agent_assignments')
      .select('account_id')
      .eq('user_id', userId);

    const workerAccountIds = (workerAssignments || []).map(a => a.account_id).filter(Boolean);
    let workerAccounts = [];
    if (workerAccountIds.length > 0) {
      const { data } = await db
        .from('whatsapp_accounts')
        .select('id, name, phone_number_id, project')
        .in('id', workerAccountIds);
      workerAccounts = data || [];
    }

    const seen = new Map();
    for (const a of [...(froAssignments || []), ...(crmAssignments || []), ...workerAccounts]) {
      const acct = a.whatsapp_accounts || a;
      if (acct?.id && !seen.has(acct.id)) seen.set(acct.id, acct);
    }
    return res.json(Array.from(seen.values()));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
