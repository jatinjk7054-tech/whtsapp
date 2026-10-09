import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

// Renders the per-worker attendance + deduction report as a .docx.
//
// The template at backend/templates/attendance-deduction-report.docx is a
// committed asset; regenerate it with `node scripts/build-report-template.mjs`.
// Its placeholders are DATA ONLY — docxtemplater performs text substitution and
// never executes anything, the same guarantee the certificate engine gives
// (see the note at the top of services/certificateDocx.js).

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '..', '..', 'templates', 'attendance-deduction-report.docx');

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let cachedTemplate = null;

function loadTemplate() {
  if (!cachedTemplate) cachedTemplate = readFileSync(TEMPLATE_PATH);
  return cachedTemplate;
}

const inr = (n) => {
  const v = Math.round(Number(n) || 0);
  return '₹' + v.toLocaleString('en-IN');
};

const dash = (v) => (v == null || v === '' ? '—' : String(v));

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const fmtDay = (n) => (n == null ? '—' : String(n));

export function reportFileName(report) {
  const name = String(report.worker.name || 'volunteer')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${name}-attendance-deduction-${report.month.key}.docx`;
}

export function renderAttendanceReportDocx(report) {
  const zip = new PizZip(loadTemplate());
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  const provisionalNote = report.month.provisional
    ? `Provisional: generated mid-month. Attendance is scored only up to day ${report.month.viewingToday} of ${report.month.daysInMonth}. Figures will change once ${report.month.label} closes.`
    : '';

  const data = {
    monthLabel: report.month.label,
    generatedAt: new Date(report.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    provisionalNote,

    name: report.worker.name || '',
    loginId: report.worker.loginId || '',
    department: report.worker.department || '',
    dateOfJoining: dash(report.worker.dateOfJoining),
    employmentStatus: report.worker.employmentStatus || '',
    daysInMonth: report.month.daysInMonth,

    monthlySalary: inr(report.salary.monthly),
    perDayRate: '₹' + (Number(report.salary.perDay) || 0).toFixed(2),

    attendanceSummary: report.attendanceSummary.map((r) => ({
      label: r.label,
      value: String(r.value ?? ''),
    })),

    dailyRows: report.dailyRows.map((r) => ({
      day: r.day,
      date: r.date,
      dayName: r.dayName,
      statusLabel: r.statusLabel,
      punchIn: fmtTime(r.punchIn),
      punchOut: fmtTime(r.punchOut),
      note: r.note || '',
    })),

    deductions: report.deductions.map((d) => ({
      label: d.label,
      days: String(d.days),
      amount: inr(d.amount),
      detail: d.detail,
    })),

    // Evidence table for the pooled late rule: minutes per day with a running
    // total. It deliberately carries no per-day amount column, because the
    // policy divides the pooled total — attributing money to single days would
    // contradict how the deduction is actually calculated.
    hasLateLog: (report.lateLog || []).length > 0,
    lateLog: (report.lateLog || []).map((r) => {
      const [y, m, d] = String(r.date).split('-');
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] || '';
      return {
        date: `${d} ${mon} ${y}`,
        minutes: String(r.minutes),
        running: String(r.runningMinutes),
      };
    }),

    totalDeductionAmount: inr(report.totalDeductionAmount),
    totalDeductionDays: String(report.totalDeductionDays),

    paidSummary: report.paidSummary.map((r) => ({
      label: r.label,
      value: String(r.value ?? ''),
    })),

    grossPresentDays: fmtDay(report.totals.grossPresentDays),
    netPresentDays: fmtDay(report.totals.netPresentDays),
    monthSalary: inr(report.totals.monthSalary),
    incentiveTotal: inr(report.totals.incentiveTotal),
    grossPayable: inr(report.totals.grossPayable),
    advanceDeduction: inr(report.totals.advanceDeduction),
    netPayable: inr(report.totals.netPayable),

    hasLoans: report.loans.length > 0,
    loans: report.loans.map((l) => ({
      type: l.type || '',
      totalAmount: inr(l.totalAmount),
      monthlyDeduction: inr(l.monthlyDeduction),
      remainingAmount: inr(l.remainingAmount),
      period: [l.startMonth, l.endMonth || 'ongoing'].filter(Boolean).join(' → '),
    })),

    hasAllocations: report.allocations.length > 0,
    allocations: report.allocations.map((a) => ({
      ngoName: a.ngoName,
      portion: inr(a.portion),
      perDay: inr(a.perDay),
      totalDue: inr(a.totalDue),
    })),
  };

  try {
    doc.render(data);
  } catch (err) {
    const detail = err?.properties?.errors?.map((e) => e.message).join('; ') || err.message;
    throw new Error(`Attendance report template render failed: ${detail}`);
  }

  return doc.getZip().generate({ type: 'nodebuffer', mimeType: DOCX_MIME });
}
