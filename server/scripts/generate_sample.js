import XLSX from 'xlsx';

const sampleData = [
  { name: 'John Doe', email: 'john@example.com', password: 'sevak@123', role: 'agent', assigned_number: '' },
  { name: 'Jane Smith', email: 'jane@example.com', password: 'sevak@123', role: 'agent', assigned_number: '' },
  { name: 'Admin User', email: 'admin@example.com', password: 'sevak@123', role: 'admin', assigned_number: '' },
];

const ws = XLSX.utils.json_to_sheet(sampleData);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Agents');

// Set column widths
ws['!cols'] = [
  { wch: 20 }, // name
  { wch: 30 }, // email
  { wch: 15 }, // password
  { wch: 12 }, // role
  { wch: 20 }, // assigned_number
];

XLSX.writeFile(wb, 'sample_agent_bulk_upload.xlsx');
console.log('Sample file created: sample_agent_bulk_upload.xlsx');
