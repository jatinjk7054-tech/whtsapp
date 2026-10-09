import ExcelJS from 'exceljs';
import db from '../src/config/db.js';
import 'dotenv/config';

const MONTH = process.env.MONTH || '2026-07';
const OUT_PATH = process.env.OUT_PATH || `Attendance_${MONTH}.xlsx`;

const [year, monthNum] = MONTH.split('-');
const daysInMonth = new Date(Date.UTC(parseInt(year), parseInt(monthNum), 0)).getUTCDate();
const startDate = `${MONTH}-01`;
const endDate = `${MONTH}-${String(daysInMonth).padStart(2, '0')}`;

const PRESENT_STATUSES = ['present', 'late', 'half-day'];

async function fetchWorkers() {
  const { data, error } = await db
    .from('workers')
    .select('id, name, department, employment_status, created_at');
  if (error) throw error;
  return data || [];
}

async function fetchSalaries() {
  const { data, error } = await db
    .from('salary_history')
    .select('worker_id, salary')
    .order('from_month', { ascending: false });
  if (error) throw error;
  const latest = {};
  for (const s of data || []) {
    if (!latest[s.worker_id]) latest[s.worker_id] = parseFloat(s.salary);
  }
  return latest;
}

async function fetchAttendance() {
  const { data, error } = await db
    .from('attendance')
    .select('worker_id, date, status')
    .gte('date', startDate)
    .lte('date', endDate);
  if (error) throw error;
  const byWorker = {};
  for (const r of data || []) {
    if (!byWorker[r.worker_id]) byWorker[r.worker_id] = [];
    byWorker[r.worker_id].push(r);
  }
  return byWorker;
}

function buildRows(workers, salaries, attendanceByWorker) {
  const rows = [];
  for (const w of workers) {
    const att = attendanceByWorker[w.id] || [];
    const present = att.filter(r => PRESENT_STATUSES.includes(r.status)).length;
    const absent = att.filter(r => r.status === 'absent').length;
    const leave = att.filter(r => r.status === 'leave').length;
    rows.push({
      name: w.name,
      department: w.department || '',
      present,
      absent,
      leave,
      total: present + absent + leave,
      daysInMonth,
      salary: salaries[w.id] || 0,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

async function generate() {
  console.log(`Fetching data for ${MONTH}...`);
  const [workers, salaries, attendanceByWorker] = await Promise.all([
    fetchWorkers(),
    fetchSalaries(),
    fetchAttendance(),
  ]);
  console.log(`Workers: ${workers.length}, attendance records fetched`);

  const rows = buildRows(workers, salaries, attendanceByWorker);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Attendance System';
  const ws = wb.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { header: 'S.No', key: 'sno', width: 6 },
    { header: 'Worker Name', key: 'name', width: 28 },
    { header: 'Department', key: 'department', width: 16 },
    { header: 'Present Days', key: 'present', width: 14 },
    { header: 'Absent Days', key: 'absent', width: 13 },
    { header: 'Leave Days', key: 'leave', width: 13 },
    { header: 'Total Days', key: 'total', width: 12 },
    { header: 'Days in Month', key: 'daysInMonth', width: 14 },
    { header: `Salary (${MONTH})`, key: 'salary', width: 16 },
  ];

  const headerCell = ws.getRow(1);
  headerCell.height = 22;
  headerCell.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF2E75B6' } } };
  });

  const green = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
  const darkGreen = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9BE1A6' } };
  const red = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
  const orange = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
  const yellow = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  const lightBlue = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };

  rows.forEach((r, i) => {
    const row = ws.addRow({
      sno: i + 1,
      name: r.name,
      department: r.department,
      present: r.present,
      absent: r.absent,
      leave: r.leave,
      total: r.total,
      daysInMonth: r.daysInMonth,
      salary: r.salary > 0 ? r.salary : '',
    });

    row.getCell('sno').alignment = { horizontal: 'center' };
    row.getCell('present').alignment = { horizontal: 'center' };
    row.getCell('absent').alignment = { horizontal: 'center' };
    row.getCell('leave').alignment = { horizontal: 'center' };
    row.getCell('total').alignment = { horizontal: 'center' };
    row.getCell('daysInMonth').alignment = { horizontal: 'center' };
    row.getCell('salary').numFmt = '#,##0';

    const presentCell = row.getCell('present');
    const absentCell = row.getCell('absent');
    const totalCell = row.getCell('total');
    const salaryCell = row.getCell('salary');

    if (r.total === 0) {
      row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; });
      absentCell.fill = red;
      absentCell.value = 'No Data';
      presentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    } else {
      if (r.absent === 0 && r.leave === 0) {
        presentCell.fill = darkGreen;
      } else {
        presentCell.fill = green;
      }
      absentCell.fill = r.absent > 0 ? red : green;
      totalCell.fill = r.absent >= 6 ? orange : lightBlue;
      if (r.salary > 0) {
        salaryCell.fill = yellow;
        salaryCell.font = { bold: true };
      }
    }

    if (r.department === 'FRO' || r.department === 'Digital') {
      row.getCell('department').fill = lightBlue;
    }

    if (i % 2 === 0) {
      row.getCell('name').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } };
    }
  });

  const lastRow = rows.length + 1;
  const totalRow = ws.addRow({
    sno: '',
    name: 'TOTAL',
    department: '',
    present: rows.reduce((s, r) => s + r.present, 0),
    absent: rows.reduce((s, r) => s + r.absent, 0),
    leave: rows.reduce((s, r) => s + r.leave, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
    daysInMonth: '',
    salary: rows.reduce((s, r) => s + r.salary, 0),
  });
  totalRow.height = 20;
  totalRow.eachCell((cell) => {
    cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  totalRow.getCell('salary').numFmt = '#,##0';

  const presentCol = ws.getColumn(4);
  const absentCol = ws.getColumn(5);
  presentCol.eachCell((cell, rowNumber) => {
    if (rowNumber === 1 || rowNumber === lastRow) return;
    if (typeof cell.value === 'number' && cell.value === 0) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
    }
  });
  absentCol.eachCell((cell, rowNumber) => {
    if (rowNumber === 1 || rowNumber === lastRow) return;
    if (typeof cell.value === 'number' && cell.value === 0) {
      cell.fill = green;
    }
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: 9 } };

  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Saved ${rows.length} workers to ${OUT_PATH}`);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
