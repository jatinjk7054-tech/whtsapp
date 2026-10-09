import { config as dotenv } from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TITLES = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'shri', 'shree',
  'kumari', 'kumar', 'sir', 'sd', 's/o', 'd/o', 'c/o',
]);

const normalizeName = (name) => {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0 && !TITLES.has(w))
    .join(' ');
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const levenshtein = (a, b) => {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
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

const resolveAgent = (agentName, workers, aliasMap) => {
  if (!agentName) return null;
  const anRaw = norm(agentName);
  const anNorm = normalizeName(agentName);

  const normed = workers.map(w => ({
    ...w,
    nn: normalizeName(w.name),
    toks: normalizeName(w.name).split(' ').filter(Boolean),
  }));

  const attempt = (name) => {
    const aNorm = normalizeName(name);
    if (!aNorm) return null;

    // Tier 1: raw exact
    const rawExact = workers.find(w => norm(w.name) === norm(name));
    if (rawExact) return rawExact;

    // Tier 2: normalized exact
    const normExact = normed.find(w => w.nn === aNorm);
    if (normExact) return normExact;

    // Tier 3: alias lookup
    const aliasId = aliasMap.get(aNorm);
    if (aliasId) {
      const w = workers.find(w => w.id === aliasId);
      if (w) return w;
    }

    // Tier 4: token-subset (unique only)
    const toks = aNorm.split(' ').filter(Boolean);
    if (toks.length >= 2) {
      let subsetHits = 0;
      let hit = null;
      for (const w of normed) {
        if (toks.every(t => w.toks.includes(t))) { subsetHits++; hit = w; }
      }
      if (subsetHits === 1) return hit;
      if (subsetHits > 1) return null;
    }

    // Tier 5: fuzzy (unique only)
    let fuzzyHits = 0;
    let hit = null;
    for (const w of workers) {
      if (nameMatch(name, w.name)) {
        fuzzyHits++;
        hit = w;
        if (fuzzyHits > 1) return null;
      }
    }
    return fuzzyHits === 1 ? hit : null;
  };

  let resolved = attempt(agentName);
  if (!resolved) {
    const stripped = agentName.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (stripped !== agentName) resolved = attempt(stripped);
  }
  return resolved || null;
};

const run = async () => {
  await client.connect();
  console.log('Connected to database.\n');

  // 1. Load all workers
  const { rows: workers } = await client.query(`SELECT id, name FROM workers`);
  console.log(`Loaded ${workers.length} workers.`);

  // 2. Load all aliases
  const workerIds = workers.filter(w => w.id).map(w => w.id);
  const aliasMap = new Map();
  for (let i = 0; i < workerIds.length; i += 500) {
    const { rows } = await client.query(
      `SELECT alias_name, worker_id FROM worker_aliases WHERE worker_id = ANY($1)`,
      [workerIds.slice(i, i + 500)]
    );
    for (const a of rows) {
      const key = norm(a.alias_name);
      if (key && !aliasMap.has(key)) aliasMap.set(key, a.worker_id);
    }
  }
  console.log(`Loaded ${aliasMap.size} aliases.\n`);

  // 3. Get all distinct agent_name values from receipts (excluding null/empty/suspense)
  const { rows: distinctNames } = await client.query(`
    SELECT DISTINCT agent_name
    FROM receipts
    WHERE agent_name IS NOT NULL
      AND trim(agent_name) != ''
      AND lower(trim(agent_name)) NOT IN ('suspense', 'na', 'priyank shah', 'priyank sir')
    ORDER BY agent_name
  `);
  console.log(`Found ${distinctNames.length} distinct agent_name values to check.\n`);

  // 4. Resolve each and build update map
  const updates = []; // { oldName, newName, workerId, receiptCount }
  const unresolved = [];
  let alreadyCorrect = 0;
  let noMatch = 0;

  for (const row of distinctNames) {
    const oldName = row.agent_name;
    const trimmed = oldName.trim();

    // Check if already matches a worker exactly (case-insensitive)
    const exactMatch = workers.find(w => norm(w.name) === norm(trimmed));
    if (exactMatch) {
      // Check if there's a case/spacing difference
      if (exactMatch.name.trim() === trimmed) {
        alreadyCorrect++;
        continue;
      }
      // Minor case/spacing difference - still fix it
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int as cnt FROM receipts WHERE agent_name = $1`,
        [oldName]
      );
      updates.push({
        oldName,
        newName: exactMatch.name.trim(),
        workerId: exactMatch.id,
        workerName: exactMatch.name.trim(),
        receiptCount: countRows[0].cnt,
      });
      continue;
    }

    // Fuzzy resolve
    const resolved = resolveAgent(trimmed, workers, aliasMap);
    if (resolved) {
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int as cnt FROM receipts WHERE agent_name = $1`,
        [oldName]
      );
      updates.push({
        oldName,
        newName: resolved.name.trim(),
        workerId: resolved.id,
        workerName: resolved.name.trim(),
        receiptCount: countRows[0].cnt,
      });
    } else {
      noMatch++;
      unresolved.push(oldName);
    }
  }

  // 5. Print report
  console.log('='.repeat(80));
  console.log('AGENT NAME FIX REPORT');
  console.log('='.repeat(80));
  console.log(`Already correct:  ${alreadyCorrect}`);
  console.log(`Will be fixed:    ${updates.length}`);
  console.log(`No match found:   ${noMatch}`);
  console.log('='.repeat(80));

  if (updates.length > 0) {
    console.log('\nFIXES TO APPLY:\n');
    console.log(
      'OLD NAME'.padEnd(40) +
      'NEW NAME (CANONICAL)'.padEnd(35) +
      'RECEIPTS'
    );
    console.log('-'.repeat(85));
    let totalReceipts = 0;
    for (const u of updates) {
      console.log(
        u.oldName.padEnd(40) +
        u.workerName.padEnd(35) +
        String(u.receiptCount).padStart(5)
      );
      totalReceipts += u.receiptCount;
    }
    console.log('-'.repeat(85));
    console.log(`TOTAL receipts to update: ${totalReceipts}`);
  }

  if (unresolved.length > 0) {
    console.log('\nUNRESOLVED agent_name values (no worker match):');
    for (const name of unresolved) {
      console.log(`  - "${name}"`);
    }
  }

  // 6. Apply updates (unless --dry-run)
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('\n[DRY RUN] No changes applied. Remove --dry-run to execute.');
  } else if (updates.length > 0) {
    console.log('\nApplying updates...');
    let updated = 0;
    for (const u of updates) {
      const { rowCount } = await client.query(
        `UPDATE receipts SET agent_name = $1 WHERE agent_name = $2`,
        [u.workerName, u.oldName]
      );
      updated += rowCount;
      console.log(`  Fixed ${rowCount} receipts: "${u.oldName}" -> "${u.workerName}"`);
    }
    console.log(`\nDone. ${updated} receipts updated.`);
  } else {
    console.log('\nNothing to fix.');
  }

  await client.end();
};

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
