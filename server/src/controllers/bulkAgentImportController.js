import XLSX from 'xlsx';
import db from '../config/db.js';

export async function bulkImportAgents(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'File is required' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ message: 'No sheets found in file' });
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ message: 'File has no data rows' });
    }

    const headers = Object.keys(rows[0]);
    const headerMap = {};
    for (const h of headers) {
      const key = h.toString().toLowerCase().replace(/[\s_\-./]+/g, '').trim();
      if (key.includes('name')) headerMap.name = h;
      else if (key.includes('email')) headerMap.email = h;
      else if (key.includes('password') || key.includes('pass')) headerMap.password = h;
      else if (key.includes('role')) headerMap.role = h;
      else if (key.includes('number') || key.includes('phone') || key.includes('mobile') || key.includes('assigned') || key.includes('account')) headerMap.assigned_number = h;
    }

    if (!headerMap.name || !headerMap.email) {
      return res.status(400).json({
        message: 'Required columns not found. File must have "name" and "email" columns.',
        detectedHeaders: headers,
      });
    }

    const validRoles = ['agent', 'admin', 'viewer'];
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[headerMap.name] || '').trim();
      const email = String(row[headerMap.email] || '').trim().toLowerCase();
      const password = headerMap.password ? String(row[headerMap.password] || '').trim() : '';
      const role = headerMap.role ? String(row[headerMap.role] || '').trim().toLowerCase() : 'agent';
      const assignedNumber = headerMap.assigned_number ? String(row[headerMap.assigned_number] || '').trim() : '';

      const errors = [];
      if (!name) errors.push('Name is required');
      if (!email) errors.push('Email is required');
      if (!email.includes('@')) errors.push('Invalid email format');
      if (!validRoles.includes(role)) errors.push(`Invalid role "${role}". Must be agent, admin, or viewer`);

      if (errors.length > 0) {
        failCount++;
        results.push({ row: i + 1, email, name, status: 'failed', error: errors.join('; ') });
        continue;
      }

      const finalPassword = password || (Math.random().toString(36).slice(-8) + 'A1!');

      try {
        const { data: agentData, error: agentError } = await db.rpc('create_agent', {
          p_email: email,
          p_password: finalPassword,
          p_name: name,
          p_role: role,
        });

        if (agentError || !agentData) {
          failCount++;
          results.push({ row: i + 1, email, name, status: 'failed', error: agentError?.message || 'Failed to create agent' });
          continue;
        }

        const createdAgent = typeof agentData === 'string' ? JSON.parse(agentData) : agentData;

        if (assignedNumber) {
          try {
            const isNumeric = /^\d+$/.test(assignedNumber);
            let accountQuery = db.from('whatsapp_accounts').select('id');
            if (isNumeric) {
              accountQuery = accountQuery.eq('phone_number_id', assignedNumber);
            } else {
              accountQuery = accountQuery.ilike('name', assignedNumber);
            }
            const { data: accounts } = await accountQuery.limit(1);

            if (accounts && accounts.length > 0) {
              await db.from('agent_phone_assignments').insert({
                user_id: createdAgent.id,
                account_id: accounts[0].id,
              });
            }
          } catch (assignErr) {
            // phone assignment failed but agent was created — still count as success
          }
        }

        successCount++;
        results.push({ row: i + 1, email, name, status: 'success', password: finalPassword });
      } catch (err) {
        failCount++;
        results.push({ row: i + 1, email, name, status: 'failed', error: err.message });
      }
    }

    return res.json({
      total: rows.length,
      success: successCount,
      failed: failCount,
      results,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
