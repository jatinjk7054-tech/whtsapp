import { getApprovedHalfDayLeave } from '../models/leaveModel.js';
import { getWorkerById } from '../models/workerModel.js';
import { getSetting } from '../models/settingsModel.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getIstTime(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function istDateStr(date = new Date()) {
  const ist = getIstTime(date);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
}

export async function getOfficeStart(workerId) {
  try {
    const worker = await getWorkerById(workerId);
    if (worker?.shift_start_time) {
      const [hour, minute] = worker.shift_start_time.split(':').map(Number);
      return { hour: hour || 10, minute: minute || 0 };
    }
  } catch (_) {}
  const value = await getSetting('office_start_time');
  if (!value) return { hour: 10, minute: 0 };
  const [hour, minute] = value.split(':').map(Number);
  return { hour: hour || 10, minute: minute || 0 };
}

export async function getOfficeEnd(workerId) {
  try {
    const worker = await getWorkerById(workerId);
    if (worker?.shift_end_time) {
      const [hour, minute] = worker.shift_end_time.split(':').map(Number);
      return { hour: hour || 19, minute: minute || 0 };
    }
  } catch (_) {}
  const value = await getSetting('office_end_time');
  if (!value) return { hour: 19, minute: 0 };
  const [hour, minute] = value.split(':').map(Number);
  return { hour: hour || 19, minute: minute || 0 };
}

export async function calculateAttendanceStatus({ workerId, punchInTime, punchOutTime }) {
  const date = istDateStr(new Date(punchInTime));
  const approvedHalfDay = await getApprovedHalfDayLeave(workerId, date);

  const start = await getOfficeStart(workerId);
  const startMinutes = start.hour * 60 + start.minute;
  const punchIn = getIstTime(new Date(punchInTime));
  const punchInMinutes = punchIn.getUTCHours() * 60 + punchIn.getUTCMinutes();
  const lateMinutes = Math.max(0, punchInMinutes - startMinutes);

  const workedMinutes = punchOutTime
    ? (new Date(punchOutTime).getTime() - new Date(punchInTime).getTime()) / 60000
    : null;

  // A worker who completed at least six hours should not remain half-day
  // because an old approved half-day leave or an incorrect shift setting is
  // attached to the date.
  const completedFullDay = workedMinutes != null && workedMinutes >= 360;
  if (approvedHalfDay && !completedFullDay) return 'half-day';
  if (lateMinutes >= 240) return 'half-day';

  if (punchOutTime) {
    const end = await getOfficeEnd(workerId);
    const endMinutes = end.hour * 60 + end.minute;
    const punchOut = getIstTime(new Date(punchOutTime));
    const punchOutMinutes = punchOut.getUTCHours() * 60 + punchOut.getUTCMinutes();
    // A complete shift must not become half-day because of a bad/stale shift
    // end value or a small timezone discrepancy in the configured times.
    if (workedMinutes < 360 && endMinutes - punchOutMinutes >= 180) return 'half-day';
  }

  return lateMinutes > 0 ? 'late' : 'present';
}
