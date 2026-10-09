const API = 'https://api.beingsevak.org/api/db/query';
async function run(sql) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) });
  const txt = await r.text();
  console.log('---', r.status, txt.slice(0, 500));
  return JSON.parse(txt);
}

// Verify test.verify_agent exists and works (returns null for unknown creds, not error)
await run(`SELECT test.verify_agent('nobody@test.com', 'wrong') AS r`);

// Verify a real test-schema function that touches tables
await run(`SELECT count(*) AS c FROM test.get_whatsapp_user(null::uuid) AS r`);
