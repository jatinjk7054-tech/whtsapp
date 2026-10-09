import db from '../config/db.js';

export async function getMessages(req, res) {
  try {
    const { conversation_id, limit = 50, offset = 0, order = 'asc' } = req.query;
    let query = db.from('messages').select('*').order('created_at', { ascending: order === 'asc' }).range(offset, offset + limit - 1);
    if (conversation_id) query = query.eq('conversation_id', conversation_id);
    const { data, error } = await query;
    if (error) return res.status(500).json({ message: 'Failed to fetch messages' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch messages' });
  }
}

export async function createMessage(req, res) {
  try {
    const messageData = req.body;
    const { data, error } = await db.from('messages').insert(messageData).select().single();
    if (error) return res.status(500).json({ message: 'Failed to create message' });
    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to create message' });
  }
}

export async function updateMessage(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;
    const { data, error } = await db.from('messages').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ message: 'Failed to update message' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update message' });
  }
}

export async function getMessageCounts(req, res) {
  try {
    const { tenant_id } = req.query;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();

    let totalQuery = db.from('messages').select('*', { count: 'exact', head: true });
    let todayQuery = db.from('messages').select('*', { count: 'exact', head: true });
    if (tenant_id) {
      totalQuery = totalQuery.eq('tenant_id', tenant_id);
      todayQuery = todayQuery.eq('tenant_id', tenant_id);
    }

    const [{ count: totalAll }, { count: totalToday }] = await Promise.all([
      totalQuery,
      todayQuery.gte('created_at', todayStr),
    ]);

    const categories = ['marketing', 'utility', 'authentication', 'service'];
    const dailyCounts = {};
    const monthlyCounts = {};

    for (const cat of categories) {
      let catToday = db.from('messages').select('*', { count: 'exact', head: true }).eq('message_category', cat).gte('created_at', todayStr);
      let catMonth = db.from('messages').select('*', { count: 'exact', head: true }).eq('message_category', cat).gte('created_at', monthStart);
      if (tenant_id) {
        catToday = catToday.eq('tenant_id', tenant_id);
        catMonth = catMonth.eq('tenant_id', tenant_id);
      }
      const [{ count: dc }, { count: mc }] = await Promise.all([catToday, catMonth]);
      dailyCounts[cat] = dc || 0;
      monthlyCounts[cat] = mc || 0;
    }

    return res.json({ total: totalAll || 0, totalToday: totalToday || 0, dailyCounts, monthlyCounts });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch message counts' });
  }
}

export async function getConversations(req, res) {
  try {
    const { status, contact_id, assigned_agent_id, tenant_id, limit = 50, offset = 0 } = req.query;
    let query = db.from('conversations').select('*, contact:contacts(*)').order('last_message_at', { ascending: false }).range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    if (contact_id) query = query.eq('contact_id', contact_id);
    if (assigned_agent_id) query = query.eq('assigned_agent_id', assigned_agent_id);
    if (tenant_id) query = query.eq('tenant_id', tenant_id);
    const { data, error } = await query;
    if (error) return res.status(500).json({ message: 'Failed to fetch conversations' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch conversations' });
  }
}

export async function getConversation(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await db.from('conversations').select('*, contact:contacts(*)').eq('id', id).maybeSingle();
    if (error) return res.status(500).json({ message: 'Failed to fetch conversation' });
    if (!data) return res.status(404).json({ message: 'Conversation not found' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch conversation' });
  }
}

export async function createConversation(req, res) {
  try {
    const convData = req.body;
    const { data, error } = await db.from('conversations').insert(convData).select().single();
    if (error) return res.status(500).json({ message: 'Failed to create conversation' });
    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to create conversation' });
  }
}

export async function updateConversation(req, res) {
  try {
    const { id } = req.params;
    const updates = req.body;
    const { data, error } = await db.from('conversations').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ message: 'Failed to update conversation' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update conversation' });
  }
}

export async function getConversationCounts(req, res) {
  try {
    const { tenant_id } = req.query;
    let baseQuery = db.from('conversations').select('*', { count: 'exact', head: true });
    if (tenant_id) baseQuery = baseQuery.eq('tenant_id', tenant_id);

    const { count: total } = await baseQuery;
    const { count: open } = await db.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'open');
    const { count: closed } = await db.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'closed');

    return res.json({ total: total || 0, open: open || 0, closed: closed || 0 });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch conversation counts' });
  }
}

export async function getConversationByContact(req, res) {
  try {
    const { contact_id } = req.query;
    if (!contact_id) return res.status(400).json({ message: 'contact_id required' });
    const { data, error } = await db.from('conversations').select('id').eq('contact_id', contact_id);
    if (error) return res.status(500).json({ message: 'Failed to fetch conversations' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch conversations' });
  }
}
