import { listAgentsForAccount, assignAgentToAccount, removeAgentFromAccount, searchWorkers, getAccountForFro } from '../models/froWhatsAppAssignmentModel.js';

export async function listAgents(req, res) {
  try {
    const agents = await listAgentsForAccount(req.params.accountId);
    return res.json(agents);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function assignAgent(req, res) {
  try {
    const { froWorkerId } = req.body;
    if (!froWorkerId) return res.status(400).json({ message: 'froWorkerId is required' });

    const agent = await assignAgentToAccount(froWorkerId, req.params.accountId);
    return res.status(201).json(agent);
  } catch (error) {
    if (error.message.includes('already assigned')) return res.status(409).json({ message: error.message });
    return res.status(500).json({ message: error.message });
  }
}

export async function removeAgent(req, res) {
  try {
    await removeAgentFromAccount(req.params.froId, req.params.accountId);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function searchAgents(req, res) {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const workers = await searchWorkers(q);
    return res.json(workers);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function myAccount(req, res) {
  try {
    const assignment = await getAccountForFro(req.user.id);
    return res.json(assignment);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
