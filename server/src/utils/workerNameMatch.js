import db from '../config/db.js';

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

let _workerCache = null;
let _aliasCache = null;

async function loadWorkers() {
  if (_workerCache) return _workerCache;
  const { data } = await db.from('workers').select('id, name');
  _workerCache = data || [];
  return _workerCache;
}

async function loadAliases() {
  if (_aliasCache) return _aliasCache;
  const workers = await loadWorkers();
  const workerIds = workers.filter((w) => w.id).map((w) => w.id);
  const aliasMap = new Map();
  for (let i = 0; i < workerIds.length; i += 500) {
    const { data } = await db
      .from('worker_aliases')
      .select('alias_name, worker_id')
      .in('worker_id', workerIds.slice(i, i + 500));
    for (const a of data || []) {
      const key = norm(a.alias_name);
      if (key && !aliasMap.has(key)) aliasMap.set(key, a.worker_id);
    }
  }
  _aliasCache = aliasMap;
  return _aliasCache;
}

export function clearCaches() {
  _workerCache = null;
  _aliasCache = null;
}

export async function resolveAgentToWorker(rawAgentName) {
  if (!rawAgentName) return null;
  const workers = await loadWorkers();
  if (workers.length === 0) return null;
  const aliases = await loadAliases();
  const anRaw = norm(rawAgentName);
  const anNorm = normalizeName(rawAgentName);

  const normed = workers.map((w) => ({
    ...w,
    nn: normalizeName(w.name),
    toks: normalizeName(w.name).split(' ').filter(Boolean),
  }));

  const byId = (id) => workers.find((w) => w.id === id) || null;

  const attempt = (agentName) => {
    const aNorm = normalizeName(agentName);
    if (!aNorm) return null;

    const rawExact = workers.find(
      (w) => norm(w.name) === anRaw
    );
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

export async function buildAgentNameFilter(workerName) {
  const w = (await loadWorkers()).find(
    (w) => norm(w.name) === norm(workerName)
  );
  if (!w) return { canonical: workerName, patterns: [workerName] };

  const aliases = await loadAliases();
  const patterns = new Set();
  patterns.add(w.name);
  patterns.add(workerName);

  const workerNorm = normalizeName(w.name);
  for (const [aliasNorm, wid] of aliases) {
    if (wid === w.id) patterns.add(aliasNorm);
  }

  return { canonical: w.name, patterns: [...patterns] };
}

export async function normalizeAgentName(rawName) {
  if (!rawName) return rawName;
  const trimmed = String(rawName).trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === 'suspense' || lower === 'na' || lower === 'pg' || lower === 'library') return trimmed;

  const workerId = await resolveAgentToWorker(trimmed);
  if (!workerId) return trimmed;

  const workers = await loadWorkers();
  const worker = workers.find((w) => w.id === workerId);
  return worker ? worker.name.trim() : trimmed;
}
