const API = 'https://api.beingsevak.org/api/db/query';
async function run(sql) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) });
  const txt = await r.text();
  console.log('---', r.status, txt.slice(0, 400));
  return JSON.parse(txt);
}

await run(`INSERT INTO test.donor_profiles (name, mobile_number) VALUES ('WRITE_TEST_VERIFY', '9876543210') RETURNING id, name, mobile_number`);

// confirm sequence advanced correctly
await run(`SELECT last_value FROM test.donor_profiles_id_seq`);

// clean up the test row so clone stays pristine
await run(`DELETE FROM test.donor_profiles WHERE mobile_number = '9876543210'`);
