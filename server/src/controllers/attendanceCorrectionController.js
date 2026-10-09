import {
  createTicket,
  getTicketById,
  getWorkerTickets,
  getPendingTickets,
  getHrVerifiedTickets,
  getAllTickets,
  updateTicket,
  getPendingTicketCount,
} from '../models/attendanceCorrectionModel.js';
import { getAttendanceById, updateAttendance, createAttendance } from '../models/attendanceModel.js';
import { getWorkerById } from '../models/workerModel.js';
import { getSetting } from '../models/settingsModel.js';
import { getApprovedHalfDayLeave } from '../models/leaveModel.js';
import { calculateAttendanceStatus } from '../utils/attendanceStatus.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getIstTime(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function istDateStr(date = new Date()) {
  const ist = getIstTime(date);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function getOfficeStart(workerId) {
  if (workerId) {
    try {
      const worker = await getWorkerById(workerId);
      if (worker?.shift_start_time) {
        const [h, m] = worker.shift_start_time.split(':').map(Number);
        return { hour: h || 10, minute: m || 0 };
      }
    } catch (_) {}
  }
  const val = await getSetting('office_start_time');
  if (!val) return { hour: 10, minute: 0 };
  const [h, m] = val.split(':').map(Number);
  return { hour: h || 10, minute: m || 0 };
}

async function getOfficeEnd(workerId) {
  if (workerId) {
    try {
      const worker = await getWorkerById(workerId);
      if (worker?.shift_end_time) {
        const [h, m] = worker.shift_end_time.split(':').map(Number);
        return { hour: h || 19, minute: m || 0 };
      }
    } catch (_) {}
  }
  const val = await getSetting('office_end_time');
  if (!val) return { hour: 19, minute: 0 };
  const [h, m] = val.split(':').map(Number);
  return { hour: h || 19, minute: m || 0 };
}

async function calculateLateMinutes(punchInTime, workerId) {
  const ist = getIstTime(new Date(punchInTime));
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  let effectiveStart = await getOfficeStart(workerId);
  const todayHalfDay = await getApprovedHalfDayLeave(workerId, istDateStr(new Date(punchInTime)));
  if (todayHalfDay && todayHalfDay.half_start_time) {
    const [hd, hm] = todayHalfDay.half_start_time.split(':').map(Number);
    effectiveStart = { hour: hd, minute: hm };
  }
  return (h > effectiveStart.hour || (h === effectiveStart.hour && m > effectiveStart.minute))
    ? (h - effectiveStart.hour) * 60 + m - effectiveStart.minute
    : 0;
}

async function isHalfDayByLatePunch(punchInTime, workerId) {
  const todayHalfDay = await getApprovedHalfDayLeave(workerId, istDateStr(new Date(punchInTime)));
  if (todayHalfDay && todayHalfDay.half_start_time) return false;
  const start = await getOfficeStart(workerId);
  const startMin = start.hour * 60 + start.minute;
  const ist = getIstTime(new Date(punchInTime));
  const punchMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return (punchMin - startMin) >= 240;
}

async function isHalfDayByEarlyPunchOut(punchOutTime, workerId) {
  const todayHalfDay = await getApprovedHalfDayLeave(workerId, istDateStr(new Date(punchOutTime)));
  if (todayHalfDay && todayHalfDay.half_start_time) return false;
  const end = await getOfficeEnd(workerId);
  const endMin = end.hour * 60 + end.minute;
  const ist = getIstTime(new Date(punchOutTime));
  const punchMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return (endMin - punchMin) >= 180;
}

export const raiseTicket = async (req, res) => {
  try {
    const { attendance_id: rawAttendanceId, date, field, requested_time, reason } = req.body;
    if (!date || !field || !requested_time || !reason) {
      return res.status(400).json({ message: 'date, field, requested_time, and reason are required' });
    }
    if (!['punch_in', 'punch_out'].includes(field)) {
      return res.status(400).json({ message: 'field must be "punch_in" or "punch_out"' });
    }

    let attendanceId = rawAttendanceId;

    if (!attendanceId) {
      const newRecord = await createAttendance({
        worker_id: req.user.id,
        date,
        status: 'absent',
      });
      attendanceId = newRecord.id;
    } else {
      const existing = await getAttendanceById(attendanceId);
      if (!existing) {
        return res.status(404).json({ message: 'Attendance record not found' });
      }
      if (existing.worker_id !== req.user.id) {
        return res.status(403).json({ message: 'You can only raise tickets for your own attendance' });
      }
    }

    const openTickets = await getWorkerTickets(req.user.id);
    const hasPending = openTickets.some(t => t.attendance_id === attendanceId && t.field === field && t.status === 'pending');
    if (hasPending) {
      return res.status(400).json({ message: 'You already have a pending ticket for this attendance record and field' });
    }
    const ticket = await createTicket({
      worker_id: req.user.id,
      attendance_id: attendanceId,
      date,
      field,
      requested_time,
      reason,
      status: 'pending',
    });
    return res.status(201).json({ message: 'Ticket raised successfully', ticket });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const myTickets = async (req, res) => {
  try {
    const tickets = await getWorkerTickets(req.user.id);
    return res.json(tickets);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listPending = async (req, res) => {
  try {
    const tickets = await getPendingTickets();
    return res.json(tickets);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listHrVerified = async (req, res) => {
  try {
    const tickets = await getHrVerifiedTickets();
    return res.json(tickets);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAllTickets = async (req, res) => {
  try {
    const tickets = await getAllTickets();
    return res.json(tickets);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTicket = async (req, res) => {
  try {
    const ticket = await getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    return res.json(ticket);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const verifyTicket = async (req, res) => {
  try {
    const { hr_remark } = req.body;
    const ticket = await getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (ticket.status !== 'pending') return res.status(400).json({ message: `Ticket is already ${ticket.status}` });
    const updated = await updateTicket(req.params.id, { status: 'hr_verified', hr_remark: hr_remark || null });
    return res.json({ message: 'Ticket verified by HR', ticket: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const approveTicket = async (req, res) => {
  try {
    const { admin_remark } = req.body;
    const ticket = await getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (ticket.status !== 'hr_verified') return res.status(400).json({ message: 'Ticket must be HR-verified before approval' });

    const attendance = await getAttendanceById(ticket.attendance_id);
    if (!attendance) return res.status(404).json({ message: 'Associated attendance record not found' });

    const updates = {};
    if (ticket.field === 'punch_in') {
      updates.punch_in_time = ticket.requested_time;
      updates.late_minutes = await calculateLateMinutes(ticket.requested_time, ticket.worker_id);
      const status = await calculateAttendanceStatus({ workerId: ticket.worker_id, punchInTime: ticket.requested_time });
      updates.status = status;
    } else {
      updates.punch_out_time = ticket.requested_time;
      if (attendance.status !== 'leave' && attendance.status !== 'absent') {
        const punchInTime = attendance.punch_in_time;
        updates.late_minutes = await calculateLateMinutes(punchInTime, ticket.worker_id);
        updates.status = await calculateAttendanceStatus({
          workerId: ticket.worker_id,
          punchInTime,
          punchOutTime: ticket.requested_time,
        });
      }
    }

    await updateAttendance(ticket.attendance_id, updates);
    const updated = await updateTicket(req.params.id, { status: 'approved', admin_remark: admin_remark || null });
    return res.json({ message: 'Ticket approved and attendance updated', ticket: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const rejectTicket = async (req, res) => {
  try {
    const { remark } = req.body;
    const ticket = await getTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    if (ticket.status === 'approved' || ticket.status === 'rejected') {
      return res.status(400).json({ message: `Ticket is already ${ticket.status}` });
    }
    const updates = { status: 'rejected' };
    const role = req.user.role;
    if (role === 'super_admin') updates.admin_remark = remark || null;
    else updates.hr_remark = remark || null;
    const updated = await updateTicket(req.params.id, updates);
    return res.json({ message: 'Ticket rejected', ticket: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const pendingCount = async (req, res) => {
  try {
    const count = await getPendingTicketCount();
    return res.json({ count });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
