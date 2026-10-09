import db from '../config/db.js';
import {
  getTodayAttendance,
  createAttendance,
  updateAttendance,
} from '../models/attendanceModel.js';
import { getFirstQRCode } from '../models/attendanceModel.js';
import { getWorkerById } from '../models/workerModel.js';
import { haversineDistance } from '../utils/geo.js';
import { getSetting } from '../models/settingsModel.js';
import { calculateAttendanceStatus } from '../utils/attendanceStatus.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const BUCKET_NAME = 'worker-documents';

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

async function calculateLateMinutes(punchInTime, workerId) {
  const ist = getIstTime(new Date(punchInTime));
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const effectiveStart = await getOfficeStart(workerId);
  const startMinutes = effectiveStart.hour * 60 + effectiveStart.minute;
  const punchMinutes = h * 60 + m;
  const diff = punchMinutes - startMinutes;
  return diff > 0 ? Math.min(diff, 180) : 0;
}

const ensureBucket = async () => {
  const { data: buckets } = await db.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET_NAME);
  if (!exists) {
    await db.storage.createBucket(BUCKET_NAME, { public: true });
  }
};

export const selfiePunch = async (req, res) => {
  try {
    const { type, selfie_base64, mime_type, latitude, longitude } = req.body;

    if (!type || !['punch_in', 'punch_out'].includes(type)) {
      return res.status(400).json({ message: 'type must be punch_in or punch_out' });
    }
    if (!selfie_base64) {
      return res.status(400).json({ message: 'Selfie image is required' });
    }
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const qr = await getFirstQRCode();
    if (!qr) {
      return res.status(404).json({ message: 'No office location configured' });
    }

    const distance = haversineDistance(qr.latitude, qr.longitude, latitude, longitude);
    if (distance > qr.radius_meters) {
      return res.status(403).json({
        message: `Outside range (${Math.round(distance)}m / ${qr.radius_meters}m)`,
      });
    }

    await ensureBucket();
    const buffer = Buffer.from(selfie_base64, 'base64');
    const contentType = mime_type || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';
    const workerId = req.user.id;
    const fileName = `selfies/${workerId}_${type}_${Date.now()}.${ext}`;

    let { data: uploadData, error: uploadError } = await db.storage
      .from(BUCKET_NAME)
      .upload(fileName, buffer, { contentType, upsert: true });

    if (uploadError) {
      return res.status(500).json({ message: 'Upload failed: ' + uploadError.message });
    }

    const { data: publicUrlData } = db.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName);
    const selfieUrl = publicUrlData?.publicUrl;

    const now = new Date();
    const existing = await getTodayAttendance(workerId);

    if (type === 'punch_in') {
      if (existing && existing.punch_in_time) {
        return res.status(400).json({ message: 'Already punched in today' });
      }

       const lateMinutes = await calculateLateMinutes(now, workerId);
       const status = await calculateAttendanceStatus({ workerId, punchInTime: now });

      if (existing) {
        const updated = await updateAttendance(existing.id, {
          punch_in_time: now.toISOString(),
          punch_in_lat: latitude,
          punch_in_lng: longitude,
          punch_in_selfie_url: selfieUrl,
          late_minutes: lateMinutes,
          status,
          selfie_status: 'pending',
        });
        return res.json({ message: 'Selfie punch-in submitted for approval', attendance: updated, lateMinutes });
      }

      const attendance = await createAttendance({
        worker_id: workerId,
        date: istDateStr(now),
        punch_in_time: now.toISOString(),
        punch_in_lat: latitude,
        punch_in_lng: longitude,
        punch_in_selfie_url: selfieUrl,
        late_minutes: lateMinutes,
        status,
        selfie_status: 'pending',
      });
      return res.status(201).json({ message: 'Selfie punch-in submitted for approval', attendance, lateMinutes });
    }

    if (type === 'punch_out') {
      if (!existing || !existing.punch_in_time) {
        return res.status(400).json({ message: 'No punch in record for today' });
      }
      if (existing.punch_out_time) {
        return res.status(400).json({ message: 'Already punched out today' });
      }

      const MIN_PUNCHOUT_MINUTES = 5;
      const elapsedMin = (now.getTime() - new Date(existing.punch_in_time).getTime()) / 60000;
      if (elapsedMin < MIN_PUNCHOUT_MINUTES) {
        const remainingSec = Math.ceil(MIN_PUNCHOUT_MINUTES * 60 - elapsedMin * 60);
        return res.status(400).json({
          message: `Punch out is available after ${MIN_PUNCHOUT_MINUTES} minutes (${remainingSec}s remaining)`,
        });
      }

       const updates = {
        punch_out_time: now.toISOString(),
        punch_out_lat: latitude,
        punch_out_lng: longitude,
        punch_out_selfie_url: selfieUrl,
         selfie_status: 'pending',
       };
       if (existing.status !== 'leave' && existing.status !== 'absent') {
         updates.status = await calculateAttendanceStatus({
           workerId,
           punchInTime: existing.punch_in_time,
           punchOutTime: now,
         });
       }
      const updated = await updateAttendance(existing.id, updates);
      return res.json({ message: 'Selfie punch-out submitted for approval', attendance: updated });
    }
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
