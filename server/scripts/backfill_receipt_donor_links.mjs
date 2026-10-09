// Backfill: stamp donor_id onto receipts that were never linked to a donor.
//
// The accounts import links receipts to donor_profiles by the last-10 mobile
// digits at import time; receipts without a matchable mobile (or imported
// before donor_profiles existed for that number) stay with donor_id = NULL.
// My Leads detail already falls back to a mobile-based match (getDonorDonations),
// but the receipts table itself should carry the link so every screen and the
// accounts side agree.
//
// Rule (mirrors the import): a receipt gets donor_id when its last-10
// donor_mobile digits match exactly ONE donor_profiles.mobile_number. Anything
// ambiguous, empty-mobile, or with an existing donor_id is skipped and reported.
//
//   node scripts/backfill_receipt_donor_links.mjs            # dry run
//   node scripts/backfill_receipt_donor_links.mjs --apply     # write
import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_SSL !== 'false' ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function main() {
  await client.connect();
  try {
    const { rows: donors } = await client.query(
      `SELECT id, mobile_number FROM donor_profiles
        WHERE mobile_number IS NOT NULL AND mobile_number <> ''`
    );
    const donorByMobile = new Map();
    for (const d of donors) {
      const m = last10(d.mobile_number);
      if (m.length !== 10) continue;
      if (!donorByMobile.has(m)) donorByMobile.set(m, []);
      donorByMobile.get(m).push(d.id);
    }

    const { rows: unlinked } = await client.query(
      `SELECT id, donor_name, donor_mobile, project_id, receipt_no
         FROM receipts
        WHERE donor_id IS NULL
          AND donor_mobile IS NOT NULL AND donor_mobile <> ''
        ORDER BY id`
    );
    console.log(`Donor profiles with a 10-digit mobile: ${donorByMobile.size}`);
    console.log(`Receipts with donor_id = NULL (have a mobile): ${unlinked.length}`);
    if (!APPLY) console.log('DRY RUN — pass --apply to stamp donor_id.\n');

    const linkedByDonor = new Map(); // donor_id -> [receipt ids]
    const noMobileMatch = [];
    const ambiguous = [];
    for (const r of unlinked) {
      const m = last10(r.donor_mobile);
      if (m.length !== 10 || !donorByMobile.has(m)) {
        if (noMobileMatch.length < 20) noMobileMatch.push({ id: r.id, donor_mobile: r.donor_mobile, donor_name: r.donor_name });
        continue;
      }
      const ids = donorByMobile.get(m);
      if (ids.length !== 1) {
        if (ambiguous.length < 20) ambiguous.push({ id: r.id, donor_mobile: r.donor_mobile, candidates: ids.length });
        continue;
      }
      const donorId = ids[0];
      if (!linkedByDonor.has(donorId)) linkedByDonor.set(donorId, []);
      linkedByDonor.get(donorId).push(r.id);
    }

    const totalLinked = [...linkedByDonor.values()].reduce((s, a) => s + a.length, 0);
    console.log(`Would link:                    ${totalLinked} receipts across ${linkedByDonor.size} donors`);
    console.log(`Skipped (no mobile match):     ${noMobileMatch.length}`);
    console.log(`Skipped (mobile not unique):   ${ambiguous.length}`);

    if (APPLY && totalLinked > 0) {
      let updated = 0;
      for (const [donorId, ids] of linkedByDonor) {
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH);
          const r = await client.query(
            `UPDATE receipts SET donor_id = $1 WHERE id = ANY($2::int[]) AND donor_id IS NULL`,
            [donorId, chunk]
          );
          updated += r.rowCount;
        }
      }
      console.log(`\nLinked ${updated} receipts.`);
    } else if (totalLinked > 0) {
      console.log('\nFirst 12 to link:');
      let shown = 0;
      for (const [donorId, ids] of linkedByDonor) {
        for (const rid of ids) {
          if (shown++ >= 12) break;
          console.log(`  receipt ${rid} -> donor ${donorId}`);
        }
        if (shown >= 12) break;
      }
    }

    if (noMobileMatch.length > 0) {
      console.log('\nNo-mobile-match samples (first 20):');
      for (const s of noMobileMatch) console.log(`  receipt ${s.id} (${s.donor_name}) mobile "${s.donor_mobile}"`);
    }
    if (ambiguous.length > 0) {
      console.log('\nAmbiguous-mobile samples (first 20):');
      for (const s of ambiguous) console.log(`  receipt ${s.id} mobile "${s.donor_mobile}" -> ${s.candidates} donors`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});