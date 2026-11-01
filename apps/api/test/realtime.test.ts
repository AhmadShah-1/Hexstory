import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POLICY } from '../src/policy.js';
import {
  TRUST,
  cellAt,
  type ChatMessage,
  type ClientToServerEvents,
  type SendResult,
  type ServerToClientEvents,
} from '@hexstory/shared';
import { createRedisCoordinator, type Coordinator } from '../src/coordination.js';
import { createDb, type Sql } from '../src/db.js';
import { ORIGIN, buildTestApp, makeUser, resetDatabase, testDatabaseUrl } from './helpers.js';

/**
 * Two app instances sharing PostgreSQL and Redis, as on Vercel. Uses a real Redis when
 * TEST_REDIS_URL is set, otherwise ioredis-mock (which shares data and Pub/Sub in-process).
 */
const HEARTBEAT_MS = 100;
const CELL = cellAt(48.8566, 2.3522, 5);
const prefix = `hx:test-${randomUUID()}:`;

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { got: { messages: ChatMessage[]; hidden: string[]; presence: number[]; resyncs: number } };

let sql: Sql;
const redisConns: Redis[] = [];
const newRedis = (): Redis => {
  const conn = process.env.TEST_REDIS_URL ? new Redis(process.env.TEST_REDIS_URL) : (new RedisMock() as unknown as Redis);
  redisConns.push(conn);
  return conn;
};
const newCoordinator = (): Coordinator & { subscriber: Redis } => {
  const subscriber = newRedis();
  return { ...createRedisCoordinator(newRedis(), subscriber, prefix), subscriber };
};

const apps: Awaited<ReturnType<typeof buildTestApp>>[] = [];
const clients: Client[] = [];
let coordA: ReturnType<typeof newCoordinator>;
let urlA: string, urlB: string, appB: Awaited<ReturnType<typeof buildTestApp>>;

async function startInstance(coordinator: Coordinator) {
  const app = await buildTestApp(sql, { coordinator, heartbeatMs: HEARTBEAT_MS });
  apps.push(app);
  return { app, url: await app.listen({ port: 0, host: '127.0.0.1' }) };
}

async function client(url: string, cookie: string): Promise<Client> {
  const socket = connect(url, { path: '/socket.io', transports: ['websocket'], extraHeaders: { cookie, origin: ORIGIN } }) as Client;
  socket.got = { messages: [], hidden: [], presence: [], resyncs: 0 };
  socket.on('message', (m) => socket.got.messages.push(m));
  socket.on('hidden', ({ id }) => socket.got.hidden.push(id));
  socket.on('presence', ({ count }) => socket.got.presence.push(count));
  socket.on('resync', () => socket.got.resyncs++);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  await new Promise<void>((resolve) => socket.emit('join', CELL, resolve));
  return socket;
}

const send = (socket: Client, body: string) => socket.timeout(3_000).emitWithAck('send', { cell: CELL, body }) as Promise<SendResult>;

async function waitFor(check: () => boolean, what: string) {
  for (const started = Date.now(); Date.now() - started < 4_000; ) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const chatter = async () => (await makeUser(sql, { trust: TRUST.MEMBER, ageDays: 1 })).headers.cookie;

beforeAll(async () => {
  sql = createDb(testDatabaseUrl());
  await resetDatabase(sql);
  coordA = newCoordinator();
  urlA = (await startInstance(coordA)).url;
  const b = await startInstance(newCoordinator());
  urlB = b.url;
  appB = b.app;
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  for (const app of apps) await app.close();
  await Promise.allSettled(redisConns.map((c) => c.quit()));
  await sql.end();
});

describe('the Square across instances', () => {
  it('relays a message posted on one instance to listeners on another', async () => {
    const onA = await client(urlA, await chatter());
    const onB = await client(urlB, await chatter());
    expect(await send(onA, 'hello from A')).toEqual({ ok: true });
    await waitFor(() => onB.got.messages.some((m) => m.body === 'hello from A'), 'message on B');
    await waitFor(() => onA.got.messages.some((m) => m.body === 'hello from A'), 'own message on A');
  });

  it("relays a moderator's removal to every instance", async () => {
    const onA = await client(urlA, await chatter());
    await send(onA, 'please remove me');
    await waitFor(() => onA.got.messages.some((m) => m.body === 'please remove me'), 'message');
    const id = onA.got.messages.find((m) => m.body === 'please remove me')!.id;

    const moderator = await makeUser(sql, { trust: TRUST.REVIEWER });
    const res = await appB.inject({ method: 'POST', url: `/api/messages/${id}/hide`, headers: moderator.headers, payload: {} });
    expect(res.statusCode).toBe(200);
    await waitFor(() => onA.got.hidden.includes(id), 'hidden event on A');
  });

  it('counts presence across instances and forgets a vanished instance', async () => {
    const watcher = await client(urlA, await chatter());
    await waitFor(() => watcher.got.presence.length > 0, 'presence');
    const expected = clients.length; // every socket so far is in CELL, spread over both instances
    await waitFor(() => watcher.got.presence.at(-1) === expected, `presence ${expected}`);

    // An instance that crashed leaves entries behind that nobody refreshes or removes.
    await coordA.touchPresence(CELL, ['crashed-instance:socket'], HEARTBEAT_MS * 3);
    await waitFor(() => watcher.got.presence.at(-1) === expected + 1, 'ghost counted');
    await waitFor(() => watcher.got.presence.at(-1) === expected, 'ghost expired');
  });

  it('enforces the chat cooldown across instances', async () => {
    const cookie = await chatter();
    const onA = await client(urlA, cookie);
    const onB = await client(urlB, cookie);
    expect(await send(onA, 'first')).toEqual({ ok: true });
    expect(await send(onB, 'second, too soon')).toEqual({ ok: false, error: 'Slow down a little.' });
  });

  it('shares rate limits across instances', async () => {
    const user = await makeUser(sql, { trust: TRUST.MEMBER });
    const ask = (app: (typeof apps)[number]) => app.inject({ method: 'POST', url: '/api/uploads', headers: user.headers, payload: { size: 1000 } });
    for (let i = 0; i < POLICY.uploadsPerHour; i++) expect((await ask(apps[i % 2]!)).statusCode).toBe(201);
    expect((await ask(apps[0]!)).statusCode).toBe(429);
    expect((await ask(apps[1]!)).statusCode).toBe(429);
  });

  it('asks clients to refetch when its Redis subscription reconnects', async () => {
    const onA = await client(urlA, await chatter());
    const onB = await client(urlB, await chatter());
    coordA.subscriber.emit('ready'); // what ioredis emits after reconnecting
    await waitFor(() => onA.got.resyncs > 0, 'resync on A');
    expect(onB.got.resyncs).toBe(0);
  });

  it('saves the message and says so when it cannot be relayed', async () => {
    const broken = newCoordinator();
    const { url } = await startInstance({ ...broken, publish: () => Promise.reject(new Error('redis down')) });
    const sender = await client(url, await chatter());
    expect(await send(sender, 'saved but not relayed')).toEqual({ ok: true, delayed: true });
    await waitFor(() => sender.got.messages.some((m) => m.body === 'saved but not relayed'), 'local echo');
    const history = (await appB.inject({ url: `/api/cells/${CELL}/messages` })).json<ChatMessage[]>();
    expect(history.map((m) => m.body)).toContain('saved but not relayed');
  });

  it('rejects messages instead of saving them when the cooldown cannot be checked', async () => {
    const broken = newCoordinator();
    const { url } = await startInstance({ ...broken, claim: () => Promise.reject(new Error('redis down')) });
    const sender = await client(url, await chatter());
    const res = await send(sender, 'should not be saved');
    expect(res.ok).toBe(false);
    const history = (await appB.inject({ url: `/api/cells/${CELL}/messages` })).json<ChatMessage[]>();
    expect(history.map((m) => m.body)).not.toContain('should not be saved');
  });
});
