const { Client } = require('pg');
const c = new Client({ connectionString: 'postgres://ucs_admin:Sevak1432P@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/ucs_crm', ssl: { rejectUnauthorized: false } });
c.connect().then(async () => {
  const r = await c.query("SELECT d.id, d.name, d.mobile_number, COUNT(a.id) as assignment_count FROM donor_profiles d JOIN fro_assignments a ON a.donor_id = d.id WHERE a.batch_type = 'new_data' AND a.status != 'reassigned' GROUP BY d.id, d.name, d.mobile_number ORDER BY d.name LIMIT 50");
  console.log(JSON.stringify(r.rows, null, 2));
  await c.end();
}).catch(e => { console.error(e.message); process.exit(1); });
