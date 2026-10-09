const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: 'postgres://ucs_admin:Sevak1432P@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/ucs_crm',
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  // 1. Find the receipt
  const { rows: receipts } = await client.query(
    "SELECT id, receipt_no, project_id, log_id, donor_id, agent_name, donor_name, created_at FROM receipts WHERE receipt_no = '82104' AND project_id = 'bsct'"
  );
  console.log('Receipts found:', JSON.stringify(receipts, null, 2));

  if (receipts.length === 0) {
    console.log('No receipt found. Aborting.');
    await client.end();
    return;
  }

  const receiptId = receipts[0].id;

  // 2. Check for bank_audit_entries referencing this receipt
  const { rows: entries } = await client.query(
    'SELECT id, receipt_id, payer_name, amount FROM bank_audit_entries WHERE receipt_id = $1',
    [receiptId]
  );
  console.log('Bank audit entries referencing this receipt:', JSON.stringify(entries, null, 2));

  // 3. Unlink bank_audit_entries
  if (entries.length > 0) {
    await client.query(
      'UPDATE bank_audit_entries SET receipt_id = NULL WHERE receipt_id = $1',
      [receiptId]
    );
    console.log('Unlinked', entries.length, 'bank_audit_entries');
  }

  // 4. Delete the receipt
  const { rowCount } = await client.query('DELETE FROM receipts WHERE id = $1', [receiptId]);
  console.log('Deleted receipt:', rowCount, 'row(s)');

  // 5. Verify deletion
  const { rows: check } = await client.query(
    "SELECT id FROM receipts WHERE receipt_no = '82104' AND project_id = 'bsct'"
  );
  console.log('Verification - remaining rows:', check.length);

  await client.end();
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
