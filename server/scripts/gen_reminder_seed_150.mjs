/**
 * Generates backend/migrations/150_replace_reminder_data_27sep2026.sql
 *
 * Source: "Priyank Sir Bills Due Dated 27th Sept, 2026.xlsx", Sheet3 only.
 * Sheet1 (61 rows) and Sheet2 (79 rows) are older partial drafts of the same
 * data and are ignored.
 *
 * Sheet3 layout: 130 rows = 1 header + 129 body, no blank rows.
 *   27 section / sub-section heading rows (skipped, they only name a category)
 * 102 bill lines, all of them seeded. The sheet does not fill every cell, so
 * some rows stay null on purpose rather than getting a made-up date:
 *   54 carry a real due date
 *   36 are label + billing-cycle only, with no due/renewal date, owner, amount
 *      or note, because the sheet leaves them empty under sub-headings such as
 *      Mobile Recharge, Fastag Recharge, Finance, Loan EMI, Credit Card Bill,
 *      Income Tax, Rent TDS and Advance Tax, plus Local Internet - AFLF/Library
 *   12 have payment or period detail but no parseable due date
 * The undated rows render with a blank Due Date and an "Upcoming" status, and
 * the notification cron will never alert on them. That is the agreed choice:
 * a billing cycle says how often, never when, so any date here would be a
 * guess that produces a wrong reminder.
 *
 * Every date in this file comes from the new sheet. Real dates are taken
 * verbatim (so a genuinely past due date correctly shows as Overdue). Only
 * recurring *text* rules ("1st Aug every year") have no single date to keep, so
 * they resolve to their next occurrence on/after TODAY.
 *
 * Usage:  node scripts/gen_reminder_seed_150.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..');
const SHEET = path.join(BACKEND, '..', 'Priyank Sir Bills Due Dated 27th Sept, 2026.xlsx');
const OUT = path.join(BACKEND, 'migrations', '150_replace_reminder_data_27sep2026.sql');

// The sheet is dated 27 Sep 2026. Recurring rules are resolved from a FIXED
// anchor so a re-run never silently moves the dataset: this must stay pinned
// to the day the 150 migration was generated (see "Generated 2026-09-28").
const TODAY = new Date('2026-09-28T00:00:00');

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Sentinel cells that are deliberately not dates.
const SENTINELS = new Set(['', 'na', 'n/a', 'nil', '-', 'paid by tenant']);

const lastDay = (y, m) => new Date(y, m, 0).getDate();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** "1.6.2026" / "30.11.2026" / "4.9.2026" -> ISO (d.m.y) */
function parseDotDate(t) {
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > lastDay(y, mo)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1-Oct-26", "16-Nov-26", "24-Feb-27", "12-Dec-25" -> ISO */
function parseDashDate(t) {
  const m = t.match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  let y = Number(m[3]);
  if (m[3].length === 2) y += 2000;
  if (d < 1 || d > lastDay(y, mo)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "1st Aug, 2026", "15th April, 2026", "4th Dec, 2028" -> ISO */
function parseLongDate(t) {
  const m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const y = Number(m[3]);
  if (d < 1 || d > lastDay(y, mo)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Any single date written in the sheet, in any of its four notations.
 * Tolerates the sheet's decorations: a leading "Renew ", a trailing
 * " till date pending", a trailing payment narrative, and bare "4.9.2026".
 */
function parseConcreteDate(raw) {
  let t = norm(raw);
  if (SENTINELS.has(t.toLowerCase())) return null;
  t = t.replace(/^renew\s+/i, '');

  for (const attempt of [t, t.split(' till date')[0].trim(), t.split(' Rs.')[0].trim()]) {
    if (!attempt) continue;
    for (const fn of [parseDotDate, parseDashDate, parseLongDate]) {
      const v = fn(attempt);
      if (v) return v;
    }
  }
  return null;
}

/**
 * Recurring text rules -> the next occurrence on/after TODAY.
 *   "1st of Every Month"            -> MONTH  interval 1  day 1
 *   "15th of Every 3 Months"        -> MONTH  interval 3  day 15
 *   "5th of Every Alternate month"  -> MONTH  interval 2  day 5
 *   "1th of Every Month"            -> MONTH  interval 1  day 1   (sheet typo)
 *   "1st Aug every year"            -> YEAR   interval 1  day 1  month 8
 *   "March of Every Year"           -> YEAR   interval 1          month 3
 *   "Every 6 Months"                -> MONTH  interval 6
 */
function parseRecurring(raw) {
  const t = norm(raw).toLowerCase();
  if (SENTINELS.has(t)) return null;

  const ord = t.match(/(\d{1,2})(?:st|nd|rd|th)/);
  const day = ord ? Number(ord[1]) : null;

  let month = null;
  for (const name of Object.keys(MONTHS)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) { month = MONTHS[name]; break; }
  }

  if (!day && month === null && !/every|month|year/.test(t)) return null;

  const isYear = /\byear(ly)?\b/.test(t) || (month !== null && !/months?/.test(t));
  const wantsMonths = /\bmonths?\b/.test(t);

  let interval = 1;
  if (/alternate/.test(t)) interval = 2;
  else {
    const every = t.match(/every\s+(\d+)\s+month/);
    if (every) interval = Number(every[1]);
    else if (/every\s+six\s+month/.test(t)) interval = 6;
    else if (/every\s+6\s+month/.test(t)) interval = 6;
  }

  // "Every 6 Months" with no day: treat as the 1st.
  const effDay = day || 1;
  if (effDay < 1 || effDay > 31) return null;

  let next;
  if (isYear) {
    // "March of Every Year" has no day -> reuse today's day-of-month.
    const d = day || TODAY.getDate();
    next = new Date(TODAY.getFullYear(), month - 1, Math.min(d, lastDay(TODAY.getFullYear(), month)));
    if (next < new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate())) {
      next = new Date(TODAY.getFullYear() + 1, month - 1, Math.min(d, lastDay(TODAY.getFullYear() + 1, month)));
    }
    return {
      date: iso(next), frequency_type: 'YEAR', frequency_interval: 1,
      day_of_month: day, month_of_year: month,
    };
  }

  if (!wantsMonths) return null;

  next = new Date(TODAY.getFullYear(), TODAY.getMonth(), Math.min(effDay, lastDay(TODAY.getFullYear(), TODAY.getMonth() + 1)));
  const floor = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate());
  if (next < floor) {
    const m = TODAY.getMonth() + interval;
    next = new Date(TODAY.getFullYear() + Math.floor(m / 12), m % 12, Math.min(effDay, lastDay(TODAY.getFullYear() + Math.floor(m / 12), (m % 12) + 1)));
  }
  return { date: iso(next), frequency_type: 'MONTH', frequency_interval: interval, day_of_month: effDay, month_of_year: null };
}

/** Billing Cycle column -> the four recurrence columns. */
function cycleToFields(cycle) {
  const t = norm(cycle).toLowerCase();
  if (t === 'monthly') return { frequency_type: 'MONTH', frequency_interval: 1, day_of_month: null, month_of_year: null };
  if (t === 'two months' || t === '2 months') return { frequency_type: 'MONTH', frequency_interval: 2, day_of_month: null, month_of_year: null };
  if (t === 'quaterly' || t === 'quarterly') return { frequency_type: 'MONTH', frequency_interval: 3, day_of_month: null, month_of_year: null };
  if (t === 'half annual' || t === 'half yearly') return { frequency_type: 'MONTH', frequency_interval: 6, day_of_month: null, month_of_year: null };
  if (t === 'annual' || t === 'yearly') return { frequency_type: 'YEAR', frequency_interval: 1, day_of_month: null, month_of_year: null };
  return { frequency_type: 'ONE_TIME', frequency_interval: 1, day_of_month: null, month_of_year: null };
}

/** "Rs. 47,000" -> 47000 ; "NA" -> null */
function parseAmount(raw) {
  const t = norm(raw).toLowerCase();
  if (!t || t === 'na' || t === 'n/a') return null;
  const m = t.replace(/^rs\.?\s*/i, '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Sheet structure
// ---------------------------------------------------------------------------

// The 27 heading rows. Anything else with a non-empty first column is a bill.
const HEADINGS = new Set([
  'Vehicle Insurance', 'Property & Taxes', 'LIC / Insurance', 'Utility Bills', 'Finance',
  'Car - Four Wheeler', 'Bike - Two Wheeler', 'Property Maintenance', 'Property BMC Tax',
  'Rent', 'Insurance', 'Policy', 'Electricity Bill', 'Piped Gas Bill',
  'Broadband and Landline', 'Post-Paid Mobile', 'Mobile Recharge', 'Fastag Recharge',
  'DTH/ Cable TV Recharge', 'Website Domain Renewal', 'Other Bill', 'Loan EMI',
  'Credit Card Bill', 'Income Tax', 'Rent TDS', 'Advance Tax', 'Accounts and Audit Fees',
]);

// Which reminders.category each heading maps into.
const HEADING_CATEGORY = {
  'Vehicle Insurance': 'VEHICLE_INSURANCE',
  'Car - Four Wheeler': 'VEHICLE_INSURANCE',
  'Bike - Two Wheeler': 'VEHICLE_INSURANCE',
  'Property Maintenance': 'PROPERTY_MAINTENANCE',
  'Property BMC Tax': 'BMC_TAX',
  'Rent': 'RENT_TDS',
  'Insurance': 'INSURANCE',
  'Policy': 'INSURANCE',
  'Electricity Bill': 'ELECTRICITY',
  'Rent TDS': 'RENT_TDS',
  'Piped Gas Bill': 'OTHER_BILL',
  'Broadband and Landline': 'OTHER_BILL',
  'Post-Paid Mobile': 'VI_BILL',
  'Mobile Recharge': 'OTHER_BILL',
  'Fastag Recharge': 'OTHER_BILL',
  'DTH/ Cable TV Recharge': 'OTHER_BILL',
  'Website Domain Renewal': 'WEBSITE_DOMAIN',
  'Other Bill': 'OTHER_BILL',
  'Loan EMI': 'OTHER_BILL',
  'Credit Card Bill': 'OTHER_BILL',
  'Income Tax': 'OTHER_BILL',
  'Advance Tax': 'OTHER_BILL',
  'Accounts and Audit Fees': 'OTHER_BILL',
};

const wb = XLSX.readFile(SHEET);
const grid = XLSX.utils.sheet_to_json(wb.Sheets['Sheet3'], { header: 1, defval: '', raw: false })
  .map((r) => r.map(norm));

const records = [];
let heading = null;          // most recent section heading
let category = 'EDUCATION';  // rows before the first heading are Education School Fees

for (let i = 1; i < grid.length; i++) {
  const r = grid[i];
  const title = r[0];
  if (!title) continue;

  if (HEADINGS.has(title)) {
    heading = title;
    if (HEADING_CATEGORY[heading]) category = HEADING_CATEGORY[heading];
    continue;
  }

  const owner = r[1] || null;
  const cycle = r[2] || '';
  const dueRaw = r[3] || '';
  const renewRaw = r[4] || '';
  const from = r[5] || '';
  const to = r[6] || '';
  const invoice = r[7] || '';
  const invoiceDate = r[8] || '';
  const lastDue = r[9] || '';
  const lastPaid = r[10] || '';
  const lastAmount = r[11] || '';
  const remark = r[12] || '';

  // --- due date: concrete from the sheet, or resolve a recurring rule -------
  let due = null;
  let rule = null;
  const concreteDue = parseConcreteDate(dueRaw);
  if (concreteDue) {
    due = concreteDue;
  } else {
    rule = parseRecurring(dueRaw);
    if (rule) due = rule.date;
  }

  // --- recurrence: the Due Date rule wins, else the Billing Cycle -----------
  const fromCycle = cycleToFields(cycle);
  const recurrence = rule || fromCycle;
  const dayOfMonth = rule?.day_of_month ?? fromCycle.day_of_month ?? null;
  const monthOfYear = rule?.month_of_year ?? fromCycle.month_of_year ?? null;

  // --- renewal date --------------------------------------------------------
  let renewal = null;
  const concreteRenewal = parseConcreteDate(renewRaw);
  if (concreteRenewal) {
    renewal = concreteRenewal;
  } else {
    const rRule = parseRecurring(renewRaw);
    if (rRule) renewal = rRule.date;
  }

  // migration 139: renewal_date = due_date - remind_days_before
  //
  // The sheet's Renewal Date column mixes three meanings, so it is classified
  // against the due date rather than trusted blindly:
  //
  //   gap 0-30 days  a real in-cycle lead time (the range
  //                  REMIND_DAYS_BEFORE_OPTIONS offers). Keep the sheet's value.
  //   gap > 30 days  the sheet's renewal belongs to an *earlier* cycle - LIC
  //                  reads due "1st Aug every year" -> 2027-08-01 against renewal
  //                  "1st Aug, 2026" -> a 365-day lead time nobody means. Ride
  //                  the due date, lead time 0.
  //   gap negative   renewal is later than the due date, i.e. a period end
  //                  rather than a lead time (Auris: due 1 Jun 2026, renewal
  //                  30 Nov 2026). Keep the sheet's value verbatim, lead time 0.
  let remindDays = 0;
  let renewalRode = false;
  if (renewal && due) {
    const gap = Math.round((new Date(`${due}T00:00:00`) - new Date(`${renewal}T00:00:00`)) / 86400000);
    if (gap > 30) {
      renewal = due;
      remindDays = 0;
      renewalRode = true;
    } else {
      remindDays = Math.max(0, gap);
    }
  }

  // --- payment fields ------------------------------------------------------
  const paidAt = parseConcreteDate(lastPaid);
  const amount = parseAmount(lastAmount);

  // --- notes: remark + the 4 columns the reminders table cannot hold -------
  const notes = [];
  if (remark) notes.push(remark);
  const period = [from, to].filter(Boolean).join(' to ');
  if (period) notes.push(`Period ${period}`);
  if (invoice && invoice.toLowerCase() !== 'na') notes.push(`Inv ${invoice}${invoiceDate && invoiceDate.toLowerCase() !== 'na' ? ` on ${invoiceDate}` : ''}`);
  if (invoiceDate && invoiceDate.toLowerCase() !== 'na' && !invoice) notes.push(`Invoice dated ${invoiceDate}`);
  if (lastDue && lastDue.toLowerCase() !== 'na') notes.push(`Last due ${lastDue}`);

  // The sentinels ("Paid by Tenant", "NA") stay in the display columns on
  // purpose: AllReminders.jsx and Dashboard.jsx both key their "Paid" styling
  // off the literal text 'Paid by Tenant' in due_date_display.
  records.push({
    title,
    category,
    owner,
    due_date: due,
    renewal_date: renewal,
    due_date_display: dueRaw || null,
    renewal_date_display: renewRaw || null,
    frequency_type: recurrence.frequency_type,
    frequency_interval: recurrence.frequency_interval,
    day_of_month: dayOfMonth,
    month_of_year: monthOfYear,
    display_frequency: cycle || null,
    remind_days_before: remindDays,
    notes: notes.length ? notes.join(' | ') : null,
    amount,
    paid_at: paidAt,
    transaction_id: invoice && invoice.toLowerCase() !== 'na' ? invoice : null,
    // Every line in this sheet is a recurring bill. A "Paid" remark records
    // last cycle's payment (already kept in paid_at / amount / transaction_id)
    // and must NOT park the row in Completed, or the scheduler would skip it
    // and the alarm would never fire again.
    status: 'Upcoming',
    completed_at: null,
    alarm_enabled: true,
    reminder_enabled: true,
    notification_enabled: true,
    _sheetRow: i + 1,
    _heading: heading,
    _cycle: cycle,
    _remark: remark,
    _renewalClamped: renewalRode,
    _sheetRenewal: renewRaw,
    // Sheet sub-heading this row lives under. The 18 sparse Finance rows
    // (Income Tax / Advance Tax / Accounts and Audit Fees) share titles with no
    // other cell filled, so source_section is what makes them distinct.
    source_section: heading || 'Education & School Fees',
  });
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const COLS = [
  'title', 'category', 'owner', 'due_date', 'renewal_date',
  'due_date_display', 'renewal_date_display', 'frequency_type', 'frequency_interval',
  'day_of_month', 'month_of_year', 'display_frequency', 'remind_days_before',
  'notes', 'amount', 'paid_at', 'transaction_id', 'status', 'completed_at',
  'alarm_enabled', 'reminder_enabled', 'notification_enabled', 'created_by',
  'source_section',
];

const lines = [];
lines.push('-- 150: Replace all bill reminder data with the "Priyank Sir Bills Due');
lines.push('-- Dated 27th Sept, 2026" dataset (Sheet3).');
lines.push('--');
lines.push('-- Replaces the migration 124 seed. That seed only ever wrote the');
lines.push('-- *_date_display free-text columns, so due_date / renewal_date /');
lines.push('-- frequency_type were NULL on every row: the Renewal Date column rendered');
lines.push('-- blank, derivedStatus was stuck on "Upcoming", and the cron in');
lines.push('-- services/reminderNotificationScheduler.js could not alert on anything.');
lines.push('-- This migration writes real dates and recurrence fields.');
lines.push('--');
// Cell-coverage breakdown, computed rather than hardcoded so the comment
// cannot drift away from the data it describes.
const nTotal = records.length;
const nDue = records.filter((r) => r.due_date).length;
const nBare = records.filter((r) => !r.due_date && !r.renewal_date && !r.amount && !r.paid_at && !r.notes).length;
const nOther = nTotal - nDue - nBare;
const nNoOwner = records.filter((r) => !r.owner).length;

lines.push('-- Generated by scripts/gen_reminder_seed_150.mjs - do not hand edit.');
lines.push('-- Source: "Priyank Sir Bills Due Dated 27th Sept, 2026.xlsx", Sheet3.');
lines.push(`--   ${nTotal} bill lines seeded; the sheet does not fill every cell:`);
lines.push(`--     ${nDue}  carry a real due date`);
lines.push(`--     ${nBare}  are label + billing-cycle only (no date/payment/note), because`);
lines.push('--          the sheet leaves them empty under sub-headings like Mobile Recharge,');
lines.push('--          Finance, Loan EMI, Income Tax, Rent TDS and Advance Tax');
lines.push(`--     ${nOther}  have payment or period detail but no parseable due date`);
lines.push(`--   ${nNoOwner} rows have no owner. The undated rows keep nulls rather than`);
lines.push('--   invented values, so they render with a blank Due Date and an');
lines.push('--   "Upcoming" status, and the cron will never alert on them. Fill them in');
lines.push('--   from the Reminder form once the real dates are known.');
lines.push('-- Each row carries source_section (its sheet sub-heading), so the UI can');
lines.push('-- render all 27 sub-headings and the dedupe keeps the 18 sparse Finance');
lines.push('-- rows (Income Tax / Advance Tax / Accounts and Audit Fees) distinct.');
lines.push('-- Sheet1 (61 rows) and Sheet2 (79 rows) are older partial drafts: ignored.');
lines.push(`-- Generated ${iso(TODAY)} (recurring rules resolved from this date).`);
lines.push('--');
lines.push('-- Safe to re-run. reminder_device_tokens is left alone: it holds the live');
lines.push('-- FCM token and is not tied to a reminder id. reminders_id_seq is not');
lines.push('-- reset, so the ids handed out to new reminders keep climbing past any');
lines.push('-- id the app has already cached.');
lines.push('');
lines.push('BEGIN;');
lines.push('');
lines.push('DELETE FROM reminder_alert_log;');
lines.push('DELETE FROM reminder_history;');
lines.push('DELETE FROM reminders;');
lines.push('');
lines.push('ALTER TABLE reminders ADD COLUMN IF NOT EXISTS source_section text;');
lines.push('');
lines.push(`INSERT INTO reminders (${COLS.join(', ')}) VALUES`);

const tuples = records.map((r) => {
  const vals = COLS.map((c) => {
    if (c === 'created_by') return q('migration-150');
    return q(r[c]);
  });
  return '  (' + vals.join(', ') + ')';
});

lines.push(tuples.join(',\n') + ';');
lines.push('');
lines.push('COMMIT;');
lines.push('');

fs.writeFileSync(OUT, lines.join('\n'));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const byCat = {};
records.forEach((r) => { byCat[r.category] = (byCat[r.category] || 0) + 1; });
const filled = (k) => records.filter((r) => r[k] !== null && r[k] !== undefined).length;

console.log(`wrote ${OUT}`);
console.log(`bill lines: ${records.length}`);
console.log('categories: ' + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`filled: due_date=${filled('due_date')}  renewal_date=${filled('renewal_date')}  frequency_type=${filled('frequency_type')}  day_of_month=${filled('day_of_month')}  month_of_year=${filled('month_of_year')}  remind_days_before=${filled('remind_days_before')}  paid_at=${filled('paid_at')}  amount=${filled('amount')}  transaction_id=${filled('transaction_id')}  notes=${filled('notes')}`);

const unresolved = records.filter((r) => !r.due_date);
console.log(`\nno due date (${unresolved.length}):`);
unresolved.forEach((r) => console.log(`  r${r._sheetRow} [${r.category}] ${r.due_date_display || '(blank)'}  ${r.title.slice(0, 58)}`));

const clamped = records.filter((r) => r._renewalClamped);
console.log(`\nrenewal date rode the due date, lead time 0 (${clamped.length}) - the sheet's renewal column belongs to an earlier cycle:`);
clamped.forEach((r) => console.log(`  r${r._sheetRow}  due=${r.due_date}  sheet renewal="${r._sheetRenewal}"  ${r.title.slice(0, 50)}`));
