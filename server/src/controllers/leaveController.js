import {
  applyLeave,
  getWorkerLeaves,
  getAllLeaves,
  getPendingLeaves,
  updateLeaveStatus,
  getLeaveById,
} from '../models/leaveModel.js';
import { notifyNgoAdmins } from '../services/adminNotifyService.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getIstNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function istDateStr(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysBetween(a, b) {
  const aDate = new Date(istDateStr(a) + 'T00:00:00+05:30');
  const bDate = new Date(istDateStr(b) + 'T00:00:00+05:30');
  const diff = bDate.getTime() - aDate.getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

export const apply = async (req, res) => {
  try {
    const { type, leave_date, start_date, end_date, half_start_time, half_end_time, reason, proof_data, proof_mime } = req.body;
    const workerId = req.user.id;

    if (!type || !reason || !reason.trim()) {
      return res.status(400).json({ message: 'Type and reason are required' });
    }

    if (!['full_day', 'half_day', 'vacational', 'emergency'].includes(type)) {
      return res.status(400).json({ message: 'Invalid leave type' });
    }

    const now = getIstNow();
    const today = istDateStr(now);
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();

    let days = 0;
    const record = {
      worker_id: workerId,
      type,
      reason: reason.trim(),
      status: 'pending',
    };

    if (type === 'full_day') {
      if (!leave_date) {
        return res.status(400).json({ message: 'Leave date is required for full day leave' });
      }
      const ld = new Date(leave_date + 'T00:00:00+05:30');
      if (isNaN(ld.getTime())) {
        return res.status(400).json({ message: 'Invalid leave date' });
      }
      const diff = daysBetween(new Date(today + 'T00:00:00+05:30'), ld);
      if (diff < 2) {
        return res.status(400).json({ message: 'Full day leave must be applied at least 2 days prior' });
      }
      days = 1;
      record.leave_date = leave_date;
    } else if (type === 'half_day') {
      if (!leave_date || !half_start_time || !half_end_time) {
        return res.status(400).json({ message: 'Date, start time, and end time are required for half day leave' });
      }
      const ld = new Date(leave_date + 'T00:00:00+05:30');
      if (isNaN(ld.getTime())) {
        return res.status(400).json({ message: 'Invalid leave date' });
      }
      const diff = daysBetween(new Date(today + 'T00:00:00+05:30'), ld);
      if (diff < 1) {
        return res.status(400).json({ message: 'Half day leave must be applied at least 1 day prior' });
      }
      days = 1;
      record.leave_date = leave_date;
      record.half_start_time = half_start_time;
      record.half_end_time = half_end_time;
    } else if (type === 'vacational') {
      if (!start_date || !end_date) {
        return res.status(400).json({ message: 'Start date and end date are required for vacational leave' });
      }
      const sd = new Date(start_date + 'T00:00:00+05:30');
      const ed = new Date(end_date + 'T00:00:00+05:30');
      if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
        return res.status(400).json({ message: 'Invalid dates' });
      }
      if (ed < sd) {
        return res.status(400).json({ message: 'End date must be on or after start date' });
      }
      const diff = daysBetween(new Date(today + 'T00:00:00+05:30'), sd);
      if (diff < 0) {
        return res.status(400).json({ message: 'Start date cannot be in the past' });
      }
      days = daysBetween(sd, ed) + 1;
      record.start_date = start_date;
      record.end_date = end_date;
    } else if (type === 'emergency') {
      if (!leave_date) {
        return res.status(400).json({ message: 'Leave date is required for emergency leave' });
      }
      const ld = new Date(leave_date + 'T00:00:00+05:30');
      if (isNaN(ld.getTime())) {
        return res.status(400).json({ message: 'Invalid leave date' });
      }
      days = 0;
      record.leave_date = leave_date;
    }

    if (proof_data) record.proof_data = proof_data;
    if (proof_mime) record.proof_mime = proof_mime;

    record.days = days;
    const result = await applyLeave(record);
    const workerName = req.user?.name || `Worker ${workerId}`;
    await notifyNgoAdmins(
      req.user?.ngo_id,
      'New leave request',
      `${workerName} applied for ${type.replace('_', ' ')} leave`,
      'leave',
      result?.id
    );
    return res.status(201).json({ message: 'Leave application submitted', leave: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const myLeaves = async (req, res) => {
  try {
    const leaves = await getWorkerLeaves(req.user.id);
    return res.json(leaves);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAll = async (req, res) => {
  try {
    const leaves = await getAllLeaves();
    return res.json(leaves);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listPending = async (req, res) => {
  try {
    const leaves = await getPendingLeaves();
    return res.json(leaves);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_remark } = req.body;

    if (!['approved', 'rejected', 'cancelled'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved, rejected, or cancelled' });
    }

    const existing = await getLeaveById(id);
    if (!existing) {
      return res.status(404).json({ message: 'Leave application not found' });
    }

    if (status === 'cancelled') {
      if (existing.status !== 'approved') {
        return res.status(400).json({ message: 'Only approved leaves can be cancelled' });
      }
      const result = await updateLeaveStatus(id, 'rejected', 'Cancelled');
      return res.json({ message: 'Leave cancelled', leave: result });
    }

    if (existing.status !== 'pending') {
      return res.status(400).json({ message: `Leave is already ${existing.status}` });
    }

    const result = await updateLeaveStatus(id, status, admin_remark || null);
    return res.json({ message: `Leave ${status}`, leave: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
