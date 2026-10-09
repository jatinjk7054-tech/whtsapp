// Builds backend/templates/attendance-deduction-report.docx — the DOCX template
// used by src/services/attendanceReportDocx.js.
//
// The template is a real OpenXML package assembled with PizZip (already a
// backend dependency) rather than a binary checked in by hand, so it can be
// regenerated whenever the report layout changes:
//
//     node scripts/build-report-template.mjs
//
// Placeholders are plain {field} text runs. They are DATA ONLY and are never
// executed — docxtemplater only performs text substitution, exactly as the
// certificate engine in src/services/certificateDocx.js does.
//
// Repeating tables use the docxtemplater table-row loop: {#rows} opens and
// {/rows} closes inside a single <w:tr>, which must be a direct child of <w:tbl>.

import PizZip from 'pizzip';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'templates', 'attendance-deduction-report.docx');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// ---- building blocks -------------------------------------------------------

function run(text, { bold = false, size = 16, color = null, italic = false } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}`
    + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`
    + (color ? `<w:color w:val="${color}"/>` : '')
    + '</w:rPr>'
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(content, { align = null, spaceBefore = 0, spaceAfter = 40, style = null } = {}) {
  return '<w:p><w:pPr>'
    + (style ? `<w:pStyle w:val="${style}"/>` : '')
    + (align ? `<w:jc w:val="${align}"/>` : '')
    + `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}"/>`
    + '</w:pPr>' + content + '</w:p>';
}

const text = (t, o) => para(run(t, o));

function heading(t) {
  return para(run(t, { bold: true, size: 22, color: '1F3864' }), { spaceBefore: 200, spaceAfter: 80 });
}

function cell(contentXml, width, { shade = null, align = null, bold = false, size = 15 } = {}) {
  return '<w:tc><w:tcPr>'
    + `<w:tcW w:w="${width}" w:type="dxa"/>`
    + (shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '')
    + '<w:vAlign w:val="center"/>'
    + '</w:tcPr>'
    + para(contentXml || '', { align, spaceAfter: 20 })
    + '</w:tc>';
}

const textCell = (t, w, o = {}) => cell(run(t, { size: o.size ?? 15, bold: o.bold ?? false }), w, o);

// Header row is emitted with the same run helper but shaded; docxtemplater only
// substitutes {tags}, so literal header text is left untouched.
function headerRow(labels, widths) {
  return '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
    + labels.map((l, i) => textCell(l, widths[i], { shade: 'D9E2F3', bold: true })).join('')
    + '</w:tr>';
}

function table(rows, widths) {
  return '<w:tbl><w:tblPr>'
    + `<w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`
    + '<w:tblLayout w:type="fixed"/>'
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`).join('')
    + '</w:tblBorders>'
    + '<w:tblCellMar>'
    + '<w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>'
    + '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/>'
    + '</w:tblCellMar>'
    + '</w:tblPr>'
    + '<w:tblGrid>' + widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>'
    + rows.join('')
    + '</w:tbl>';
}

const tr = (...cells) => '<w:tr>' + cells.join('') + '</w:tr>';

// A two-column "label: value" line used throughout the detail blocks.
const kv = (label, valueTag, w1 = 2400, w2 = 2200) => tr(
  textCell(label, w1, { bold: true, shade: 'F2F2F2' }),
  cell(run(valueTag, { size: 15 }), w2),
);

// docxtemplater table-row loop. The opening {#name} and closing {/name} tags
// must share the row's first and last cells — giving either one a cell of its
// own makes Word render a phantom trailing column, which is why the tags are
// folded into the neighbouring field values rather than passed as fields.
const loopRow = (name, fields, widths, aligns = []) => {
  const cells = fields.map((f, i) => {
    let text = f;
    if (i === 0) text = '{#' + name + '}' + text;
    if (i === fields.length - 1) text = text + '{/' + name + '}';
    return cell(run(text, { size: 14 }), widths[i], { align: aligns[i] || null });
  });
  return tr(...cells);
};

// Page geometry: A4 portrait with narrow margins so the 7-column daily grid fits.
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 720;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ---- document body ---------------------------------------------------------

const body = [];

// Title block
body.push(para(run('ATTENDANCE & DEDUCTION REPORT', { bold: true, size: 32, color: '1F3864' }), { align: 'center', spaceAfter: 40 }));
body.push(para(run('{monthLabel}', { size: 24, color: '404040' }), { align: 'center', spaceAfter: 40 }));
body.push(para(run('Generated on {generatedAt}', { size: 14, color: '808080' }), { align: 'center', spaceAfter: 120 }));

// Provisional banner — only rendered when the month is still in progress.
body.push(table([
  tr(
    cell(
      '<w:r><w:rPr><w:b/><w:sz w:val="15"/><w:color w:val="9C5700"/></w:rPr>'
      + '<w:t xml:space="preserve">{provisionalNote}</w:t></w:r>',
      CONTENT_W,
      { shade: 'FFF2CC' },
    ),
  ),
], [CONTENT_W]));

// Volunteer details
body.push(heading('Volunteer Details'));
body.push(table([
  kv('Name', '{name}'),
  kv('Login ID', '{loginId}'),
  kv('Department', '{department}'),
  kv('Date of Joining', '{dateOfJoining}'),
  kv('Employment Status', '{employmentStatus}'),
  kv('Days in Month', '{daysInMonth}'),
  kv('Monthly Salary', '{monthlySalary}'),
  kv('Per Day Rate', '{perDayRate}'),
], [2400, 2200]));

// Attendance summary
body.push(heading('Attendance Summary'));
body.push(table(
  [
    headerRow(['Particulars', 'Value'], [3200, 1400]),
    loopRow('attendanceSummary', ['{label}', '{value}'], [3200, 1400]),
  ],
  [3200, 1400],
));

// Day-by-day grid
body.push(heading('Day-by-Day Attendance'));
const dailyW = [520, 620, 900, 700, 900, 700, 1100];
body.push(table(
  [
    headerRow(['Day', 'Date', 'Weekday', 'Status', 'Punch In', 'Punch Out', 'Note'], dailyW),
    loopRow(
      'dailyRows',
      ['{day}', '{date}', '{dayName}', '{statusLabel}', '{punchIn}', '{punchOut}', '{note}'],
      dailyW,
    ),
  ],
  dailyW,
));

// Deductions
body.push(heading('Deductions'));
const dedW = [2200, 900, 1300, CONTENT_W - 4400];
body.push(table(
  [
    headerRow(['Particulars', 'Days', 'Amount (INR)', 'Details'], dedW),
    loopRow('deductions', ['{label}', '{days}', '{amount}', '{detail}'], dedW, [null, 'right', 'right']),
    tr(
      textCell('Total', dedW[0], { bold: true, shade: 'F2F2F2' }),
      textCell('', dedW[1], { shade: 'F2F2F2' }),
      textCell('{totalDeductionAmount}', dedW[2], { bold: true, shade: 'F2F2F2' }),
      textCell('Total days deducted: {totalDeductionDays}', dedW[3], { shade: 'F2F2F2' }),
    ),
  ],
  dedW,
));

// Per-day evidence for the pooled late rule. The heading and the table both sit
// inside {#hasLateLog}, and the table's single loop row carries that same tag,
// so a month with no lateness renders neither.
body.push(heading('Late Attendance Detail {#hasLateLog}{/hasLateLog}'));
const lateW = [2400, 2400, 2400];
body.push(table(
  [
    headerRow(['Date', 'Late minutes', 'Running total (min)'], lateW),
    loopRow('lateLog', ['{date}', '{minutes}', '{running}'], lateW, [null, 'right', 'right']),
  ],
  lateW,
));

// Paid days calculation
body.push(heading('Paid Days Calculation'));
body.push(table(
  [
    headerRow(['Description', 'Days'], [3400, 1200]),
    loopRow('paidSummary', ['{label}', '{value}'], [3400, 1200], [null, 'right']),
  ],
  [3400, 1200],
));

// Earnings
body.push(heading('Salary Summary'));
body.push(table([
  kv('Gross Present Days', '{grossPresentDays}'),
  kv('Net Paid Days', '{netPresentDays}'),
  kv('Month Salary', '{monthSalary}'),
  tr(
    textCell('Incentives (FRO)', 2400, { bold: true, shade: 'F2F2F2' }),
    cell(run('{incentiveTotal}', { size: 15 }), 2200),
  ),
  tr(
    textCell('Gross Payable', 2400, { bold: true, shade: 'F2F2F2' }),
    cell(run('{grossPayable}', { size: 15, bold: true }), 2200),
  ),
  tr(
    textCell('Less: Loan / Advance Deduction', 2400, { bold: true, shade: 'F2F2F2' }),
    cell(run('{advanceDeduction}', { size: 15 }), 2200),
  ),
  tr(
    textCell('Net Payable', 2400, { bold: true, shade: 'D9E2F3' }),
    cell(run('{netPayable}', { size: 17, bold: true }), 2200, { shade: 'D9E2F3' }),
  ),
], [2400, 2200]));

// Loan / advance detail
body.push(para(run('{#hasLoans}Loan / Advance Detail{/hasLoans}', { bold: true, size: 20, color: '1F3864' }), { spaceBefore: 200, spaceAfter: 80 }));
const loanW = [1800, 1600, 1800, 1800, CONTENT_W - 7000];
body.push(table(
  [
    headerRow(['Type', 'Total Amount', 'Monthly Deduction', 'Remaining', 'Period'], loanW),
    loopRow('loans', ['{type}', '{totalAmount}', '{monthlyDeduction}', '{remainingAmount}', '{period}'], loanW, [null, 'right', 'right', 'right']),
  ],
  loanW,
));

// NGO allocation split
body.push(para(run('{#hasAllocations}NGO Allocation Split{/hasAllocations}', { bold: true, size: 20, color: '1F3864' }), { spaceBefore: 200, spaceAfter: 80 }));
const allocW = [2600, 1600, 1600, CONTENT_W - 5800];
body.push(table(
  [
    headerRow(['NGO', 'Salary Portion', 'Per Day', 'Total Due'], allocW),
    loopRow('allocations', ['{ngoName}', '{portion}', '{perDay}', '{totalDue}'], allocW, [null, 'right', 'right', 'right']),
  ],
  allocW,
));

body.push(text(
  'Figures are generated from the payroll paid-day engine and match the Salary File export for the same month.',
  { size: 13, color: '808080', italic: true },
));

const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:body>' + body.join('')
  + '<w:sectPr>'
  + `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>`
  + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="720" w:footer="720" w:gutter="0"/>`
  + '</w:sectPr>'
  + '</w:body></w:document>';

const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '</Types>';

const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';

const zip = new PizZip();
zip.file('[Content_Types].xml', contentTypes);
zip.file('_rels/.rels', rootRels);
zip.file('word/document.xml', documentXml);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));

console.log('Wrote ' + OUT);
