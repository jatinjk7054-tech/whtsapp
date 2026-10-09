// Lightweight Redis cache wrapper (fail-open)
const Redis = require('ioredis');
const crypto = require('crypto');

let client = null;
let isConnected = false;

function getRedisUrl() {
  return process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL || '';
}

function createClient() {
  const url = getRedisUrl();
  if (!url) {
    return null;
  }
  try {
    const opts = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      reconnectOnError: () => true,
      retryStrategy: (times) => Math.min(times * 100, 1000),
    };
    if (url.startsWith('rediss://')) {
      opts.tls = { rejectUnauthorized: false };
    }
    const c = new Redis(url, opts);
    c.on('connect', () => { isConnected = true; });
    c.on('ready', () => { isConnected = true; });
    c.on('error', () => { isConnected = false; });
    c.on('end', () => { isConnected = false; });
    c.on('close', () => { isConnected = false; });
    c.connect().catch(() => { });
    return c;
  } catch (err) {
    return null;
  }
}

function getClient() {
  if (!client) client = createClient();
  return client;
}

function isReady() {
  const c = getClient();
  if (!c) return false;
  return isConnected;
}

async function get(key) {
  const c = getClient();
  if (!c || !isReady()) return null;
  try {
    const v = await c.get(key);
    if (v == null) return null;
    try { return JSON.parse(v); } catch { return v; }
  } catch {
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  const c = getClient();
  if (!c || !isReady()) return false;
  try {
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await c.set(key, payload, 'EX', ttlSeconds);
    } else {
      await c.set(key, payload);
    }
    return true;
  } catch {
    return false;
  }
}

async function del(keys) {
  const c = getClient();
  if (!c || !isReady()) return 0;
  try {
    if (!keys) return 0;
    const arr = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
    if (!arr.length) return 0;
    const res = await c.del(...arr);
    return res || 0;
  } catch {
    return 0;
  }
}

// Delete every key under a prefix.
//
// Station payloads are keyed per (user x ngo x range), so a mutation by one admin
// has to invalidate keys belonging to every other admin's session - they cannot be
// enumerated from the keyspace locally, so this walks the server instead of
// guessing at ids. SCAN (not KEYS) so it never blocks Upstash, and the loop is
// bounded so a pathological keyspace degrades into a partial delete plus the TTL
// expiry rather than an unbounded request. Fail-open like everything else here: a
// miss just means the old entries age out on their own.
async function delByPrefix(prefix, maxIterations = 50) {
  const c = getClient();
  if (!c || !isReady() || !prefix) return 0;
  let deleted = 0;
  try {
    let cursor = '0';
    for (let i = 0; i < maxIterations; i++) {
      const [next, batch] = await c.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (batch && batch.length > 0) {
        deleted += await c.del(...batch);
      }
      if (cursor === '0') break;
    }
    return deleted;
  } catch {
    return deleted;
  }
}

function hashKey(parts) {
  if (parts == null) return '0';
  const s = Array.isArray(parts) ? parts.map(p => String(p)).join('|') : String(parts);
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

module.exports = {
  getClient,
  isReady,
  get,
  set,
  del,
  delByPrefix,
  hashKey,
};
