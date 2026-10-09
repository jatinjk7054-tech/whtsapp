import db, { sql } from '../config/db.js';
import { getISTToday } from '../utils/salaryDays.js';
import { getReport, listReportsForDate, upsertReport } from '../models/hrDailyReportModel.js';

// HR > Reports, the data side.
//
// The screen is deliberately hybrid, and only the half that cannot be derived
// lives here:
//
//   attendance summary  computed live from workers/attendance/leaves below.
//                       Never stored, so it can never go stale.
//   absences/terminations  typed by HR, persisted in hr_daily_reports.
//   recruiter MIS      counted client-side from the leads the HR panel already
//                       has loaded, so this router stays out of the leads
//                       pipeline entirely.
//
// date handling: every pooled session is pinned to Asia/Kolkata in
// config/db.js, so `::date` casts on the timestamptz columns (leaves.applied_at,
// workers.created_at) mean the IST calendar day. The `attendance.date` and
// `leaves.*_date` columns are real DATE columns holding an IST calendar day
// already, so they compare to a 'YYYY-MM-DD' string directly.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The regex on its own is not enough. '2026-13-45' and '2026-02-30' both match
// /^\d{4}-\d{2}-\d{2}$/ but are not real days, and Postgres rejects them with
// 'date/time field value out of range' — which would turn a client typo into a
// 500. Round-tripping the parts through Date rejects those here instead, so they
// stay the caller's fault (400) where they belong.
const isIsoDate = (value) => {
  const text = String(value ?? '');
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

const clampText = (value, max) => (value == null ? '' : String(value).slice(0, max));

// mis_manual is free text typed by HR, so it is clamped and whitelisted rather
// than trusted: an unknown field would silently bloat the JSONB and would never
// be rendered by any screen.
//
// Which fields are manual is a data decision, not a preference. Probing the live
// database showed `call_logs` is empty (no call records at all), lead interview
// entries only ever carry status 'Scheduled' or 'Cancelled' with no completed
// marker, and no lead status or column anywhere represents a joining. So
// Interviews Attended, Joining Confirmed and Calls Made have no source to
// derive from and are typed by the reporter instead.
const MANUAL_FIELDS = [
  'interviews_attended', 'joining_confirmed', 'calls_made', 'interested', 'remarks',
];

const sanitizeMisManual = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, 200)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = {};
    for (const field of MANUAL_FIELDS) {
      if (value[field] !== undefined) entry[field] = clampText(value[field], 1000);
    }
    if (Object.keys(entry).length > 0) out[String(key).slice(0, 64)] = entry;
  }
  return out;
};

// The reporter is the signed-in user, resolved from the users table rather than
// trusted from the request body: `reporter_name` is the key the saved row and
// the WhatsApp recipient are looked up by, so letting the client choose it would
// let one HR user overwrite or impersonate another's day. The JWT carries only
// { id, email, role } — there is no name in it — hence the lookup.
async function resolveReporterName(req) {
  const id = req.user?.id;
  if (id) {
    const { data, error } = await db
      .from('users')
      .select('name')
      .eq('id', id)
      .maybeSingle();
    if (!error && data?.name) return String(data.name).trim();
    if (error) console.error('[hr-reports] reporter name lookup failed:', error.message);
  }
  return String(req.user?.email || 'Unknown reporter').trim();
}

// One round trip for the whole summary. Four separate builder queries would each
// pull the workers table and re-derive the roster; this way the roster is built
// once and every figure is guaranteed to be counting the same set of people.
const ATTENDANCE_SUMMARY_SQL = `
WITH roster AS (
  SELECT w.id
  FROM workers w
  WHERE COALESCE(w.is_active, true) = true
    AND COALESCE(w.employment_status, 'active') IS DISTINCT FROM 'terminated'
    AND COALESCE(w.is_test, false) = false
    -- Someone who joined after the report date was never expected to be in, so
    -- counting them would invent absences out of nothing. NULL created_at is
    -- kept: backfilled rows would otherwise silently vanish from the roster.
    AND (w.created_at IS NULL OR w.created_at::date <= $1::date)
),
-- Full-day leave only. A 'half_day' leave is deliberately excluded: an approved
-- half-day leave is already applied to the attendance status itself (see
-- getApprovedHalfDayLeave in models/leaveModel.js), so counting it here too
-- would deduct the same person twice.
on_leave AS (
  SELECT DISTINCT l.worker_id
  FROM leaves l
  JOIN roster r ON r.id = l.worker_id
  WHERE l.status = 'approved'
    AND (
      (l.type IN ('full_day', 'emergency') AND l.leave_date = $1::date)
      OR (l.type IN ('vacational', 'holiday') AND l.start_date <= $1::date AND l.end_date >= $1::date)
    )
)
SELECT
  (SELECT COUNT(*) FROM roster)::int AS total_staff,
  (SELECT COUNT(DISTINCT a.worker_id) FROM attendance a
     JOIN roster r ON r.id = a.worker_id
    WHERE a.date = $1::date AND a.status IN ('present', 'late'))::int AS present,
  (SELECT COUNT(DISTINCT a.worker_id) FROM attendance a
     JOIN roster r ON r.id = a.worker_id
    WHERE a.date = $1::date AND a.status = 'half-day')::int AS half_day,
  (SELECT COUNT(*) FROM on_leave)::int AS on_leave,
  (SELECT COUNT(*) FROM workers w
    WHERE COALESCE(w.is_active, true) = true
      AND COALESCE(w.employment_status, 'active') IS DISTINCT FROM 'terminated'
      AND COALESCE(w.is_test, false) = true)::int AS test_members
`;

export async function attendanceSummary(req, res) {
  const date = isIsoDate(req.query.date) ? req.query.date : getISTToday();
  try {
    const rows = await sql(ATTENDANCE_SUMMARY_SQL, [date]);
    const row = rows[0] || {};
    const totalStaff = Number(row.total_staff) || 0;
    const present = Number(row.present) || 0;
    const halfDay = Number(row.half_day) || 0;
    const onLeave = Number(row.on_leave) || 0;

    // Attendance stores no 'absent' rows — a missing punch IS the absence — so
    // absent is whatever is left of the roster. Clamped at 0 because a punch
    // from a worker outside the roster, or an approved leave for someone who
    // also punched, can otherwise drive this negative and print "-2 absent".
    const absent = Math.max(0, totalStaff - present - halfDay - onLeave);

    return res.json({
      date,
      total_staff: totalStaff,
      present,
      half_day: halfDay,
      on_leave: onLeave,
      absent,
      test_members: Number(row.test_members) || 0,
    });
  } catch (error) {
    console.error('[hr-reports] attendance summary failed:', error.message);
    return res.status(500).json({ message: error.message });
  }
}

// Every saved report for a date, so the screen can show who has filled theirs in
// and still only let the signed-in reporter edit their own row.
export async function getReports(req, res) {
  const date = req.query.date;
  if (!isIsoDate(date)) {
    return res.status(400).json({ message: 'date query parameter is required (YYYY-MM-DD)' });
  }
  try {
    const reports = await listReportsForDate(date);
    return res.json({ date, reports });
  } catch (error) {
    console.error('[hr-reports] fetch failed:', error.message);
    return res.status(500).json({ message: error.message });
  }
}

export async function getMyReport(req, res) {
  const date = req.query.date;
  if (!isIsoDate(date)) {
    return res.status(400).json({ message: 'date query parameter is required (YYYY-MM-DD)' });
  }
  try {
    const reporter_name = await resolveReporterName(req);
    const report = await getReport(date, reporter_name);
    return res.json({ date, reporter_name, report });
  } catch (error) {
    console.error('[hr-reports] fetch own report failed:', error.message);
    return res.status(500).json({ message: error.message });
  }
}

export async function saveReport(req, res) {
  const { date, absent_wopi, absent_wpi, terminations, mis_manual } = req.body || {};
  if (!isIsoDate(date)) {
    return res.status(400).json({ message: 'date is required (YYYY-MM-DD)' });
  }
  try {
    const reporter_name = await resolveReporterName(req);
    const report = await upsertReport({
      report_date: date,
      reporter_name,
      absent_wopi: clampText(absent_wopi, 2000),
      absent_wpi: clampText(absent_wpi, 2000),
      terminations: clampText(terminations, 2000),
      mis_manual: sanitizeMisManual(mis_manual),
      created_by: req.user?.id ? String(req.user.id) : null,
    });
    return res.json({ success: true, report });
  } catch (error) {
    console.error('[hr-reports] save failed:', error.message);
    return res.status(500).json({ message: error.message });
  }
}
