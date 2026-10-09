const {Pool}=require("pg");
const p=new Pool({connectionString:"postgres://ucs_app:xm4BAoZRhOVU3NFW2qLe@ucs-crm-db.cv8asue2a57e.ap-south-1.rds.amazonaws.com:5432/postgres",ssl:{rejectUnauthorized:false}});
(async()=>{
  const deleteIds=[1885027,1885029,1885028,1885419,1885010,1885008,1885004];
  console.log("=== DELETING 7 DUPLICATE ORPHANS ===");

  // 1. Unlink BAEs first
  const unlink = await p.query("UPDATE bank_audit_entries SET receipt_id = NULL WHERE receipt_id = ANY()", [deleteIds]);
  console.log("BAEs unlinked:", unlink.rowCount);

  // 2. Delete the receipts
  const del = await p.query("DELETE FROM receipts WHERE id = ANY() RETURNING id, receipt_no, payment_id, donor_name, amount", [deleteIds]);
  console.log("Receipts deleted:", del.rowCount);
  del.rows.forEach(r => console.log("  Deleted id="+r.id+" | "+r.payment_id+" | "+r.donor_name+" | "+r.amount));

  // 3. Reset receipt counters for affected projects
  const projects = ["bsct","aflf"];
  for (const proj of projects) {
    const maxRes = await p.query("SELECT MAX(receipt_no)::int as max_no FROM receipts WHERE project_id= AND receipt_no IS NOT NULL", [proj]);
    const maxNo = maxRes.rows[0].max_no || 0;
    const upd = await p.query("UPDATE receipt_no_counters SET last_no =  WHERE project_id =  RETURNING *", [maxNo, proj]);
    if (upd.rowCount > 0) {
      console.log("Counter reset: "+proj+" -> "+maxNo);
    } else {
      console.log("Counter: "+proj+" no counter found, inserting");
      await p.query("INSERT INTO receipt_no_counters(project_id,last_no) VALUES(,)", [proj, maxNo]);
      console.log("Counter created: "+proj+" -> "+maxNo);
    }
  }

  // 4. Verify - show remaining * prefix orphans
  const rem = await p.query("SELECT COUNT(*) as cnt FROM receipts WHERE payment_id LIKE '\*%' AND receipt_no IS NULL AND receipt_date >= '2026-08-01'");
  console.log("Remaining * orphans from Aug 2026:", rem.rows[0].cnt);

  await p.end();
})();