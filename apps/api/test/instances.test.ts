import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRUST } from '@hexstory/shared';
import { createRedisCoordinator } from '../src/coordination.js';
import { createDb, type Sql } from '../src/db.js';
import { POLICY } from '../src/policy.js';
import { buildTestApp, makeUser, resetDatabase, testDatabaseUrl } from './helpers.js';

/**
 * Two app instances sharing PostgreSQL and Redis, as on Vercel. Uses a real Redis when
 * TEST_REDIS_URL is set, otherwise ioredis-mock (which shares data in-process).
 */
const prefix = `hx:test-${randomUUID()}:`;
let sql: Sql;
const redisConns: Redis[] = [];
const newRedis = (): Redis => {
  const conn = process.env.TEST_REDIS_URL ? new Redis(process.env.TEST_REDIS_URL) : (new RedisMock() as unknown as Redis);
  redisConns.push(conn);
  return conn;
};
const apps: Awaited<ReturnType<typeof buildTestApp>>[] = [];

beforeAll(async () => {
  sql = createDb(testDatabaseUrl());
  await resetDatabase(sql);
  for (let i = 0; i < 2; i++) apps.push(await buildTestApp(sql, { coordinator: createRedisCoordinator(newRedis(), prefix) }));
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await Promise.all(redisConns.map((c) => c.quit().catch(() => {})));
  await sql.end();
});

describe('several instances', () => {
  it('shares rate limits across instances', async () => {
    const user = await makeUser(sql, { trust: TRUST.MEMBER });
    const ask = (app: (typeof apps)[number]) => app.inject({ method: 'POST', url: '/api/uploads', headers: user.headers, payload: { size: 1000 } });
    for (let i = 0; i < POLICY.uploadsPerHour; i++) expect((await ask(apps[i % 2]!)).statusCode).toBe(201);
    expect((await ask(apps[0]!)).statusCode).toBe(429);
    expect((await ask(apps[1]!)).statusCode).toBe(429);
  });

  it('no longer serves the retired live chat', async () => {
    expect((await apps[0]!.inject({ url: '/socket.io/?EIO=4&transport=websocket' })).statusCode).toBe(404);
    expect((await apps[0]!.inject({ url: '/api/cells/851fb467fffffff/messages' })).statusCode).toBe(404);
  });
});
