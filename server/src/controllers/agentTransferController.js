import db from '../config/db.js';

export async function transferConversation(req, res) {
  try {
    const { conversation_id, target_agent_id } = req.body;

    if (!conversation_id || !target_agent_id) {
      return res.status(400).json({ message: 'conversation_id and target_agent_id are required' });
    }

    const { data: conversation, error } = await db
      .from('conversations')
      .update({ assigned_agent_id: target_agent_id })
      .eq('id', conversation_id)
      .select('*, contact:contacts(*)')
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    return res.json({ success: true, conversation });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function claimConversation(req, res) {
  try {
    const { conversation_id } = req.body;

    if (!conversation_id) {
      return res.status(400).json({ message: 'conversation_id is required' });
    }

    const { data: conversation, error } = await db
      .from('conversations')
      .update({ assigned_agent_id: req.user.id })
      .eq('id', conversation_id)
      .is('assigned_agent_id', null)
      .select('*, contact:contacts(*)')
      .single();

    if (error) {
      return res.status(500).json({ message: error.message });
    }

    if (!conversation) {
      return res.status(400).json({ message: 'Conversation is already assigned to another agent' });
    }

    return res.json({ success: true, conversation });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
