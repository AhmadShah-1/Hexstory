import { Redis } from 'ioredis';
import type { ChatMessage } from '@hexstory/shared';

/** A broadcast to the sockets in one hex room, on every instance. */
export type RoomEvent =
  | { type: 'message'; cell: string; message: ChatMessage }
  | { type: 'hidden'; cell: string; id: string }
  | { type: 'presence'; cell: string; count: number };

/**
 * State every API instance must agree on. On Vercel many function instances run at once and each
 * holds its own WebSocket connections, so chat fan-out, presence and cooldowns go through Redis.
 * Locally a single process keeps them in memory. PostgreSQL stays the durable record of chat;
 * nothing here is needed to recover history.
 */
export interface Coordinator {
  /** Delivers an event to every instance, this one included. Rejects if it could not be published. */
  publish(event: RoomEvent): Promise<void>;
  /**
   * Receives events from every instance. `onGap` fires when the subscription was interrupted and
   * events may have been missed, so connected clients should refetch.
   */
  subscribe(onEvent: (event: RoomEvent) => void, onGap: () => void): Promise<void>;
  /** Atomically takes `key` for `ttlMs`. False if someone already holds it (cooldowns). */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Marks members present in a room until `ttlMs` from now; members that stop refreshing expire. */
  touchPresence(cell: string, members: string[], ttlMs: number): Promise<void>;
  removePresence(cell: string, member: string): Promise<void>;
  countPresence(cell: string): Promise<number>;
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
  const handlers: ((event: RoomEvent) => void)[] = [];
  const claims = new Map<string, number>();
  const presence = new Map<string, Map<string, number>>();
  // Stored as JSON text so callers never share (and mutate) the same object.
  const values = new Map<string, { json: string; until: number }>();

  const live = (cell: string) => {
    const members = presence.get(cell);
    if (!members) return 0;
    const now = Date.now();
    for (const [member, until] of members) if (until <= now) members.delete(member);
    if (members.size === 0) presence.delete(cell);
    return members.size;
  };

  return {
    rateLimitRedis: null,
    keyPrefix: 'hx:',
    async publish(event) {
      // Async like Redis delivery, so callers can't come to depend on synchronous fan-out.
      queueMicrotask(() => handlers.forEach((h) => h(event)));
    },
    async subscribe(onEvent) {
      handlers.push(onEvent);
    },
    async claim(key, ttlMs) {
      const now = Date.now();
      if ((claims.get(key) ?? 0) > now) return false;
      if (claims.size > 10_000) for (const [k, until] of claims) if (until <= now) claims.delete(k);
      claims.set(key, now + ttlMs);
      return true;
    },
    async touchPresence(cell, members, ttlMs) {
      const room = presence.get(cell) ?? new Map<string, number>();
      for (const m of members) room.set(m, Date.now() + ttlMs);
      presence.set(cell, room);
    },
    async removePresence(cell, member) {
      presence.get(cell)?.delete(member);
    },
    async countPresence(cell) {
      return live(cell);
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
      handlers.length = 0;
    },
  };
}

/**
 * Redis-backed coordinator. Uses plain Pub/Sub for fan-out (one channel; every instance relays to
 * its own sockets), a sorted set per room for presence (score = expiry time) and SET NX PX for
 * cooldowns. Commands fail fast instead of queueing while Redis is unreachable, so callers can
 * report the failure rather than silently claiming success.
 *
 * `client` runs commands; `subscriber` is a second connection dedicated to SUBSCRIBE, as Redis
 * requires. Together they are the two connections each instance holds.
 */
export function createRedisCoordinator(client: Redis, subscriber: Redis, keyPrefix: string): Coordinator {
  const channel = `${keyPrefix}square`;
  const presenceKey = (cell: string) => `${keyPrefix}presence:${cell}`;

  return {
    rateLimitRedis: client,
    keyPrefix,
    async publish(event) {
      await client.publish(channel, JSON.stringify(event));
    },
    async subscribe(onEvent, onGap) {
      subscriber.on('message', (ch: string, payload: string) => {
        if (ch !== channel) return;
        try {
          onEvent(JSON.parse(payload) as RoomEvent);
        } catch (err) {
          console.error('square: bad event payload', err);
        }
      });
      // ioredis re-subscribes after every reconnect, but anything published while this instance
      // was away is lost, so connected clients are told to refetch. (At startup no sockets exist
      // yet, so the first 'ready' reaches nobody.)
      subscriber.on('ready', onGap);
      // Queued until Redis is reachable; startup never waits on it.
      subscriber.subscribe(channel).catch((err) => console.error('square: subscribe failed', err));
    },
    async claim(key, ttlMs) {
      return (await client.set(`${keyPrefix}${key}`, '1', 'PX', ttlMs, 'NX')) === 'OK';
    },
    async touchPresence(cell, members, ttlMs) {
      if (members.length === 0) return;
      const until = Date.now() + ttlMs;
      const key = presenceKey(cell);
      await execOrThrow(
        client
          .multi()
          .zadd(key, ...members.flatMap((m) => [until, m]))
          .pexpire(key, ttlMs),
      );
    },
    async removePresence(cell, member) {
      await client.zrem(presenceKey(cell), member);
    },
    async countPresence(cell) {
      const key = presenceKey(cell);
      const results = await execOrThrow(client.multi().zremrangebyscore(key, '-inf', Date.now()).zcard(key));
      return Number(results[1]);
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
      await Promise.allSettled([subscriber.quit(), client.quit()]);
    },
  };
}

async function execOrThrow(multi: ReturnType<Redis['multi']>): Promise<unknown[]> {
  const results = (await multi.exec()) ?? [];
  for (const [err] of results) if (err) throw err;
  return results.map(([, value]) => value);
}

/**
 * Opens the two connections for a coordinator. Waits briefly for Redis so the first requests of a
 * cold start don't fail; if it is down the app still starts and ioredis keeps reconnecting, while
 * chat reports errors and rate limits fall back to allowing requests (see docs/DESIGN.md).
 */
export async function connectRedis(url: string, log: (msg: string, err?: unknown) => void) {
  const options = {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  };
  const client = new Redis(url, options);
  // The subscriber only ever runs SUBSCRIBE, which may wait in its queue until Redis is reachable.
  const subscriber = new Redis(url, { ...options, enableOfflineQueue: true, maxRetriesPerRequest: null });
  for (const [name, conn] of [['client', client], ['subscriber', subscriber]] as const) {
    // Log state changes, not every failed reconnect attempt.
    let healthy = true;
    conn.on('error', (err) => {
      if (healthy) log(`redis ${name} connection lost; retrying`, err);
      healthy = false;
    });
    conn.on('ready', () => {
      if (!healthy) log(`redis ${name} reconnected`);
      healthy = true;
    });
  }
  await Promise.all([client, subscriber].map((conn) => waitUntilReady(conn, 5_000))).catch((err) =>
    log('redis not reachable at startup; continuing and retrying in the background', err),
  );
  return { client, subscriber };
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
