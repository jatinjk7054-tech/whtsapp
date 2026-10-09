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
    console.warn('[redis] REDIS_URL not set; caching disabled');
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
    console.warn('[redis] failed to create client:', err.message);
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
  hashKey,
};
