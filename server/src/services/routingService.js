import db from '../config/db.js';

export async function listRules(accountProject) {
  let query = db.from('whatsapp_routing_rules').select('*').order('priority', { ascending: true });
  if (accountProject) query = query.eq('account_project', accountProject);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createRule({ account_project, priority, match_type, keywords, assignee_id, assignee_name, is_active }) {
  if (!account_project || !assignee_id) throw new Error('account_project and assignee_id are required');
  if (match_type && !['keyword', 'any'].includes(match_type)) throw new Error('match_type must be "keyword" or "any"');

  const { data, error } = await db
    .from('whatsapp_routing_rules')
    .insert({
      account_project,
      priority: parseInt(priority, 10) || 100,
      match_type: match_type || 'keyword',
      keywords: Array.isArray(keywords) ? keywords : [],
      assignee_id,
      assignee_name: assignee_name || null,
      is_active: is_active !== false,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateRule(id, updates) {
  const allowed = {};
  if (updates.account_project !== undefined) allowed.account_project = updates.account_project;
  if (updates.priority !== undefined) allowed.priority = parseInt(updates.priority, 10) || 100;
  if (updates.match_type !== undefined) {
    if (!['keyword', 'any'].includes(updates.match_type)) throw new Error('match_type must be "keyword" or "any"');
    allowed.match_type = updates.match_type;
  }
  if (updates.keywords !== undefined) allowed.keywords = Array.isArray(updates.keywords) ? updates.keywords : [];
  if (updates.assignee_id !== undefined) allowed.assignee_id = updates.assignee_id;
  if (updates.assignee_name !== undefined) allowed.assignee_name = updates.assignee_name || null;
  if (updates.is_active !== undefined) allowed.is_active = !!updates.is_active;

  if (Object.keys(allowed).length === 0) throw new Error('No fields to update');

  const { data, error } = await db
    .from('whatsapp_routing_rules')
    .update(allowed)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteRule(id) {
  const { error } = await db.from('whatsapp_routing_rules').delete().eq('id', id);
  if (error) throw error;
}

export async function applyRouting(conversationId, messageText, accountProject) {
  try {
    const { data: rules } = await db
      .from('whatsapp_routing_rules')
      .select('*')
      .eq('account_project', accountProject)
      .eq('is_active', true)
      .order('priority', { ascending: true })
      .limit(50);

    if (!rules || rules.length === 0) return null;

    const text = String(messageText || '').toLowerCase();

    let matched = null;
    for (const rule of rules) {
      if (rule.match_type === 'any') {
        matched = rule;
        break;
      }
      const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
      if (keywords.some((k) => text.includes(String(k).toLowerCase()))) {
        matched = rule;
        break;
      }
    }

    if (!matched) return null;

    const { error } = await db
      .from('conversations')
      .update({
        assigned_agent_id: matched.assignee_id,
        assigned_to: matched.assignee_name || null,
      })
      .eq('id', conversationId);
    if (error) throw error;

    return matched;
  } catch (err) {
    console.error('[routing] applyRouting failed:', err.message);
    return null;
  }
}
