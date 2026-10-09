// Shared TTL + LRU cache for expensive read endpoints.
//
// In-memory, per process. That is deliberate and not a compromise.
//
// Redis was evaluated as a second tier and rejected on cost. Upstash bills per
// request, and this workload's arithmetic does not survive contact with it: the
// FRO strip polls /fro/my-performance every 30s, so L2 lookups on the read path
// would run ~57,600 requests/day (20 FROs x 2,880 polls) — roughly 1.7M/month
// against a 500k/month budget. Exhausted in about four days, and it would buy
// only what the in-memory tier already provides.
//
// The important tuning detail is the relationship between TTL and poll
// interval. A TTL SHORTER than the poll interval is nearly worthless here: at
// 15s TTL against a 30s poll the entry has always expired by the next request,
// so the expensive rebuild still happens once per FRO per poll. Keeping the TTL
// comfortably ABOVE the poll interval is what makes one rebuild serve everyone —
// 60s TTL means the leaderboard is rebuilt ~1,440 times/day for the whole panel
// instead of ~57,600, and that cost is independent of how many FROs are online.
//
// Correct for a single-process backend (see src/socket.js — cluster mode would
// need a shared tier).
const DEFAULT_MAX = 200;

const stores = new Map();

function storeFor(max) {
  let s = stores.get(max);
  if (!s) {
    s = new Map();
    stores.set(max, s);
  }
  return s;
}

/**
 * Read a cached value. Returns `undefined` on miss or expiry (expired entries
 * are dropped on read so they cannot linger).
 */
export function cacheGet(key, ttlMs, max = DEFAULT_MAX) {
  const store = storeFor(max);
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() - e.t < ttlMs) return e.v;
  store.delete(key);
  return undefined;
}

/**
 * Write a value. When full, drop the oldest 25% in one pass rather than one
 * entry per write, so a burst of writes does not pay a loop iteration each.
 */
export function cacheSet(key, value, max = DEFAULT_MAX) {
  const store = storeFor(max);
  if (store.size >= max) {
    let toDrop = Math.max(1, Math.floor(max * 0.25));
    for (const k of store.keys()) {
      store.delete(k);
      if (--toDrop <= 0) break;
    }
  }
  store.set(key, { v: value, t: Date.now() });
}

/** Drop exact keys. */
export function cacheDel(...keys) {
  for (const store of stores.values()) {
    for (const k of keys) store.delete(k);
  }
}

/**
 * Drop every key starting with `prefix`. Used to invalidate one FRO's cached
 * payloads (`fro:dash:<workerId>`) without touching anyone else's. This is why
 * per-user payloads stay in-memory: Redis cannot delete a prefix cheaply, so a
 * shared tier would need a generation counter per namespace for a benefit that
 * does not exist while the backend is one process.
 */
export function cacheDelPrefix(prefix) {
  for (const store of stores.values()) {
    for (const k of [...store.keys()]) {
      if (k.startsWith(prefix)) store.delete(k);
    }
  }
}

/** Clear everything. Test/admin helper. */
export function cacheClear() {
  for (const store of stores.values()) store.clear();
}

/**
 * Run `fn` at most once per `ttlMs` per `key`, sharing the in-flight promise so
 * N concurrent callers for the same key cause ONE rebuild rather than N. This is
 * what protects the database during a burst — a plain TTL cache only helps
 * callers arriving AFTER the first one finishes, so every FRO refreshing at the
 * same moment would otherwise miss and stampede together.
 *
 * Failures are never cached: a rejected promise is evicted so the next caller
 * retries rather than replaying a transient error for the whole TTL.
 */
const inFlight = new Map();

export function cached(key, ttlMs, fn) {
  const hit = cacheGet(key, ttlMs);
  if (hit !== undefined) return Promise.resolve(hit);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = Promise.resolve()
    .then(fn)
    .then((value) => {
      cacheSet(key, value);
      return value;
    })
    .catch((err) => {
      cacheDel(key);
      throw err;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}
