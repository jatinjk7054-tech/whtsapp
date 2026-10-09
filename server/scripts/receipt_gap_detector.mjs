// Receipt-number gap detector.
// Reports missing receipt numbers per NGO, scoped to receipts issued from the
// start of the CURRENT month onward (IST) — so historical gaps are ignored.
//
// Usage:
//   node backend/scripts/receipt_gap_detector.mjs
//   DATABASE_URL=postgres://... node backend/scripts/receipt_gap_detector.mjs
//
// Exit code 0 when no gaps, 1 when gaps are found (so it can gate a CI/QA step).

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const connString =
  process.env.DATABASE_URL ||
  'postgres://ucs_app:xm4BAoZRhOVU3NFW2qLe@127.0.0.1:5434/postgres';

const PROJECTS = ['bsct', 'mann', 'aflf'];

async function main() {
  const client = new Client({ connectionString: connString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Current-month start in IST (month of now()).
  const monthStart = await client.query(
    `SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date AS d`
  );
  const start = monthStart.rows[0].d;

  let anyGaps = false;

  for (const project of PROJECTS) {
    const { rows } = await client.query(
      `SELECT receipt_no::bigint AS n
       FROM receipts
       WHERE project_id = $1
         AND receipt_no ~ '^[0-9]+$'
         AND receipt_date >= $2::date
       ORDER BY n ASC`,
      [project, start]
    );
    const nums = rows.map((r) => Number(r.n));
    if (nums.length < 2) continue;

    const set = new Set(nums);
    const gaps = [];
    for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
      if (!set.has(n)) gaps.push(n);
    }

    if (gaps.length > 0) {
      anyGaps = true;
      console.log(`\n[${project}] ${gaps.length} missing receipt number(s) from this month (${start}):`);
      // group consecutive runs for readability
      let i = 0;
      while (i < gaps.length) {
        let j = i;
        while (j + 1 < gaps.length && gaps[j + 1] === gaps[j] + 1) j++;
        if (j === i) console.log(`  ${gaps[i]}`);
        else console.log(`  ${gaps[i]} - ${gaps[j]}`);
        i = j + 1;
      }
    }
  }

  if (!anyGaps) {
    console.log(`No receipt-number gaps found from ${start} onward (${PROJECTS.join(', ')}).`);
  }

  await client.end();
  process.exit(anyGaps ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
