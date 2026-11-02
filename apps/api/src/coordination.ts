import { Redis } from 'ioredis';

/**
 * State every API instance must agree on. On Vercel many function instances run at once, so shared
 * rate limits, cooldowns and small caches go through Redis when it is configured. Locally (or
 * without REDIS_URL) a single process keeps them in memory, which is per instance on Vercel.
 * PostgreSQL is always the durable record; nothing here is needed to recover data.
 */
export interface Coordinator {
  /** Atomically takes `key` for `ttlMs`. False if someone already holds it (cooldowns). */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Counts a hit in a fixed window shared by all instances; returns the count so far in this window. */
  hit(key: string, windowMs: number): Promise<number>;
  /**
   * The Redis server's `INFO` text over the existing command connection, or null when there is no
   * shared Redis (memory coordinator). Used by the moderators' usage dashboard; rejects on failure.
   */
  info(): Promise<string | null>;
  /** A small shared JSON value, or null when absent or expired (caches shared by every instance). */
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlMs: number): Promise<void>;
  /** Client for @fastify/rate-limit's shared store, or null to keep limits in process memory. */
  rateLimitRedis: Redis | null;
  /** Prefix for any other shared keys, so environments sharing one Redis never collide. */
  keyPrefix: string;
  close(): Promise<void>;
}

/** Single-process coordinator for local development and tests. */
export function createMemoryCoordinator(): Coordinator {
  const claims = new Map<string, number>();
  const hits = new Map<string, { count: number; until: number }>();
  // Stored as JSON text so callers never share (and mutate) the same object.
  const values = new Map<string, { json: string; until: number }>();

  return {
    rateLimitRedis: null,
    keyPrefix: 'hx:',
    async hit(key, windowMs) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.until <= now) {
        if (hits.size > 10_000) for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
        hits.set(key, { count: 1, until: now + windowMs });
        return 1;
      }
      return ++entry.count;
    },
    async claim(key, ttlMs) {
      const now = Date.now();
      if ((claims.get(key) ?? 0) > now) return false;
      if (claims.size > 10_000) for (const [k, until] of claims) if (until <= now) claims.delete(k);
      claims.set(key, now + ttlMs);
      return true;
    },
    async info() {
      return null;
    },
    async getJson<T>(key: string) {
      const entry = values.get(key);
      if (!entry) return null;
      if (entry.until <= Date.now()) {
        values.delete(key);
        return null;
      }
      return JSON.parse(entry.json) as T;
    },
    async setJson(key, value, ttlMs) {
      values.set(key, { json: JSON.stringify(value), until: Date.now() + ttlMs });
    },
    async close() {
      claims.clear();
      hits.clear();
      values.clear();
    },
  };
}

/**
 * Redis-backed coordinator: SET NX PX for cooldowns, fixed-window counters, small JSON caches and
 * the rate limiter's store, all on one connection per instance. Commands fail fast instead of
 * queueing while Redis is unreachable, so callers can fall back rather than hang.
 */
export function createRedisCoordinator(client: Redis, keyPrefix: string): Coordinator {
  return {
    rateLimitRedis: client,
    keyPrefix,
    async claim(key, ttlMs) {
      return (await client.set(`${keyPrefix}${key}`, '1', 'PX', ttlMs, 'NX')) === 'OK';
    },
    async hit(key, windowMs) {
      const k = `${keyPrefix}${key}`;
      // Start the window only if there isn't one, then count.
      const [, count] = (await execOrThrow(client.multi().set(k, '0', 'PX', windowMs, 'NX').incr(k))) as [unknown, number];
      return count;
    },
    async info() {
      return client.info();
    },
    async getJson<T>(key: string) {
      const raw = await client.get(`${keyPrefix}${key}`);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    async setJson(key, value, ttlMs) {
      await client.set(`${keyPrefix}${key}`, JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlMs)));
    },
    async close() {
      await client.quit().catch(() => {});
    },
  };
}

async function execOrThrow(multi: ReturnType<Redis['multi']>): Promise<unknown[]> {
  const results = (await multi.exec()) ?? [];
  for (const [err] of results) if (err) throw err;
  return results.map(([, value]) => value);
}

/**
 * Opens the coordinator's connection. Waits briefly for Redis so the first requests of a cold start
 * don't fail; if it is down the app still starts and ioredis keeps reconnecting, while rate limits
 * fall back to allowing requests and caches to recomputing (see docs/DESIGN.md).
 */
export async function connectRedis(url: string, log: (msg: string, err?: unknown) => void): Promise<Redis> {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  });
  // Log state changes, not every failed reconnect attempt.
  let healthy = true;
  client.on('error', (err) => {
    if (healthy) log('redis connection lost; retrying', err);
    healthy = false;
  });
  client.on('ready', () => {
    if (!healthy) log('redis reconnected');
    healthy = true;
  });
  await waitUntilReady(client, 5_000).catch((err) => log('redis not reachable at startup; continuing and retrying in the background', err));
  return client;
}

function waitUntilReady(conn: Redis, timeoutMs: number): Promise<void> {
  if (conn.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out connecting to Redis')), timeoutMs);
    conn.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
