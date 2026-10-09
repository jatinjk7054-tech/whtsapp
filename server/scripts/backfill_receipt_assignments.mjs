// One-off repair: receipts exist (with a resolvable FRO agent) but their donor
// has no active fro_assignment for the receipt's NGO, so the donor is invisible
// to every FRO (My Leads + donor history are assignment-scoped).
//
// Creates one active assignment per (donor, NGO) with status
// 'donation_collected'. Never touches existing assignments, money, logs, or
// donors whose agent cannot be matched to an active worker.
//
// Dry-run by default (prints the plan). Use `--apply` to write.
// Match tiers mirror resolveAgentToWorker (workerNameMatch.js): raw exact ->
// normalized exact -> alias -> token-subset unique -> fuzzy unique.
//
//   node scripts/backfill_receipt_assignments.mjs            # dry run
//   node scripts/backfill_receipt_assignments.mjs --apply    # write

import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Name matching (parity with src/utils/workerNameMatch.js) ────────────────
const TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'shri', 'shree',
  'kumari', 'kumar', 'sir', 'sd', 's/o', 'd/o', 'c/o',
]);

const normalizeName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0 && !TITLES.has(w))
    .join(' ');

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const levenshtein = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
};

const nameMatch = (agentName, workerName) => {
  const na = normalizeName(agentName);
  const nb = normalizeName(workerName);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = na.split(' ')[0];
  const fb = nb.split(' ')[0];
  if (fa && fb && fa === fb && fa.length >= 3) return true;
  if (na.includes(nb) || nb.includes(na)) return na.length >= 3 && nb.length >= 3;
  const dist = levenshtein(na, nb);
  const ratio = 1 - dist / Math.max(na.length, nb.length);
  return ratio >= 0.7;
};

let _workers = null;
let _aliases = null;

async function loadWorkers() {
  if (_workers) return _workers;
  const r = await client.query('SELECT id, name FROM workers ORDER BY id');
  _workers = r.rows;
  return _workers;
}

async function loadAliases() {
  if (_aliases) return _aliases;
  const workers = await loadWorkers();
  const r = await client.query('SELECT alias_name, worker_id FROM worker_aliases');
  const map = new Map();
  for (const a of r.rows) {
    const key = norm(a.alias_name);
    if (key && !map.has(key)) map.set(key, a.worker_id);
  }
  _aliases = map;
  return map;
}

async function resolveAgentToWorker(rawAgentName) {
  if (!rawAgentName) return null;
  const workers = await loadWorkers();
  if (workers.length === 0) return null;
  const aliases = await loadAliases();
  const anRaw = norm(rawAgentName);
  const normed = workers.map((w) => ({
    ...w,
    nn: normalizeName(w.name),
    toks: normalizeName(w.name).split(' ').filter(Boolean),
  }));
  const byId = (id) => workers.find((w) => w.id === id) || null;

  const attempt = (agentName) => {
    const aNorm = normalizeName(agentName);
    if (!aNorm) return null;

    const rawExact = workers.find((w) => norm(w.name) === anRaw);
    if (rawExact) return rawExact.id;

    const normExact = normed.find((w) => w.nn === aNorm);
    if (normExact) return normExact.id;

    const aliasId = aliases.get(aNorm);
    if (aliasId && workers.some((w) => w.id === aliasId)) return aliasId;

    const toks = aNorm.split(' ').filter(Boolean);
    if (toks.length >= 2) {
      let subsetHits = 0;
      let hit = null;
      for (const w of normed) {
        if (toks.every((t) => w.toks.includes(t))) {
          subsetHits++;
          hit = w.id;
        }
      }
      if (subsetHits === 1) return hit;
      if (subsetHits > 1) return null;
    }

    let fuzzyHits = 0;
    let hit = null;
    for (const w of workers) {
      if (nameMatch(agentName, w.name)) {
        fuzzyHits++;
        hit = w.id;
        if (fuzzyHits > 1) return null;
      }
    }
    return fuzzyHits === 1 ? hit : null;
  };

  let resolved = byId(attempt(rawAgentName));
  if (!resolved) {
    const stripped = rawAgentName.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (stripped !== rawAgentName) resolved = byId(attempt(stripped));
  }
  return resolved || null;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const PLACEHOLDER_AGENT_SET = new Set(['suspense', 'pg', 'library', 'na']);

async function main() {
  await client.connect();
  try {
    const { rows: candidates } = await client.query(`
      SELECT r.id AS receipt_id, r.donor_id, r.project_id, r.agent_name,
             r.station, r.receipt_no, n.id AS ngo_id, d.name AS donor_name
      FROM receipts r
      JOIN donor_profiles d ON d.id = r.donor_id
      JOIN ngos n ON lower(n.name) = lower(r.project_id)
      LEFT JOIN LATERAL (
        SELECT fa.id
        FROM fro_assignments fa
        WHERE fa.donor_id = r.donor_id
          AND fa.ngo_id = n.id
          AND (fa.status IS NULL OR fa.status <> 'reassigned')
        LIMIT 1
      ) a ON true
      WHERE r.voided_at IS NULL
        AND r.donor_id IS NOT NULL
        AND COALESCE(r.agent_name, '') <> ''
        AND lower(r.agent_name) NOT IN ('suspense', 'pg', 'library', 'na')
        AND a.id IS NULL
      ORDER BY r.id ASC
    `);

    const byDonorNgo = new Map();
    for (const row of candidates || []) {
      const key = `${row.donor_id}::${row.ngo_id}`;
      if (!byDonorNgo.has(key)) byDonorNgo.set(key, row);
    }

    console.log(`Candidate receipts: ${candidates.length}`);
    console.log(`Unique (donor, NGO) pairs needing an assignment: ${byDonorNgo.size}`);
    if (!APPLY) console.log('DRY RUN — pass --apply to write the assignments.\n');

    const created = [];
    const skippedAlreadyAssigned = [];
    const skippedUnresolved = [];
    const now = new Date().toISOString();

    for (const row of byDonorNgo.values()) {
      const workerId = (await resolveAgentToWorker(row.agent_name))?.id;

      const existing = await client.query(
        `SELECT id, status FROM fro_assignments
         WHERE donor_id = $1 AND ngo_id = $2 LIMIT 1`,
        [row.donor_id, row.ngo_id]
      );
      if (existing.rows.some((a) => a.status === null || a.status !== 'reassigned')) {
        skippedAlreadyAssigned.push({ donor_id: row.donor_id, ngo_id: row.ngo_id });
        continue;
      }
      if (!workerId) {
        skippedUnresolved.push({ donor_id: row.donor_id, ngo_id: row.ngo_id, agent_name: row.agent_name, donor_name: row.donor_name });
        continue;
      }

      let station = null;
      const st = await client.query(
        `SELECT station FROM fro_station_assignments
         WHERE fro_worker_id = $1 AND ngo_id = $2 AND station IS NOT NULL LIMIT 1`,
        [workerId, row.ngo_id]
      );
      if (st.rows[0]?.station) station = st.rows[0].station;
      if (!station && row.station) station = row.station;

      if (APPLY) {
        const ins = await client.query(
          `INSERT INTO fro_assignments
             (donor_id, fro_worker_id, ngo_id, station, status, assigned_at)
           VALUES ($1, $2, $3, $4, 'donation_collected', $5)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [row.donor_id, workerId, row.ngo_id, station, now]
        );
        if (ins.rows[0]) {
          await client.query(
            `UPDATE donor_profiles SET ngo = n.name, station = $3, updated_at = now()
             FROM ngos n
             WHERE donor_profiles.id = $1 AND n.id = $2`,
            [row.donor_id, row.ngo_id, station]
          );
          created.push({ donor_id: row.donor_id, ngo_id: row.ngo_id, assignment_id: ins.rows[0].id });
        } else {
          skippedAlreadyAssigned.push({ donor_id: row.donor_id, ngo_id: row.ngo_id });
        }
      } else {
        created.push({ donor_id: row.donor_id, ngo_id: row.ngo_id, assignment_id: '—(dry)', agent_name: row.agent_name });
      }
    }

    console.log(`Created / would create:      ${created.length}`);
    console.log(`Skipped (already assigned):  ${skippedAlreadyAssigned.length}`);
    console.log(`Skipped (agent unresolved):  ${skippedUnresolved.length}`);
    if (skippedUnresolved.length > 0) {
      console.log('\nUnresolved agent samples (first 20):');
      for (const s of skippedUnresolved.slice(0, 20)) {
        console.log(`  donor ${s.donor_id} (${s.donor_name}) / NGO ${s.ngo_id} -> "${s.agent_name}"`);
      }
    }
    if (APPLY && created.length > 0) {
      console.log('\nCreated assignments:');
      for (const c of created) console.log(`  donor ${c.donor_id} / NGO ${c.ngo_id} -> assignment ${c.assignment_id}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});