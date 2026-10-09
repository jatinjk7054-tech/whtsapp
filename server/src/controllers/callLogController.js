import {
  createCallLog,
  getCallLogsByTelecaller,
  getCallLogsByLead,
  getCallLogById,
} from '../models/callLogModel.js';

export const addCallLog = async (req, res) => {
  try {
    const { lead_id, duration_seconds, call_type, status, notes, follow_up_date } = req.body;
    if (!lead_id) {
      return res.status(400).json({ message: 'lead_id is required' });
    }
    const data = {
      lead_id,
      telecaller_id: req.user.id,
      duration_seconds: duration_seconds || 0,
      call_type: call_type || 'outgoing',
      status: status || 'connected',
      notes: notes || null,
      follow_up_date: follow_up_date || null,
    };
    const log = await createCallLog(data);
    return res.status(201).json({ message: 'Call log created', log });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listMyCallLogs = async (req, res) => {
  try {
    const { lead_id, status, call_type, from_date, to_date } = req.query;
    const filters = { lead_id, status, call_type, from_date, to_date };
    const logs = await getCallLogsByTelecaller(req.user.id, filters);
    return res.json(logs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getLeadCallLogs = async (req, res) => {
  try {
    const logs = await getCallLogsByLead(req.params.leadId);
    return res.json(logs);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getSingleCallLog = async (req, res) => {
  try {
    const log = await getCallLogById(req.params.id);
    if (!log) return res.status(404).json({ message: 'Call log not found' });
    return res.json(log);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
