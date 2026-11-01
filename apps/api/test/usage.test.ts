import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRUST, type UsageReport } from '@hexstory/shared';
import { ORIGIN, makeUser, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

type Headers = Record<string, string>;
const getUsage = (headers: Headers = {}) => ctx.app.inject({ method: 'GET', url: '/api/moderation/usage', headers });
const refresh = (headers: Headers = { origin: ORIGIN }) =>
  ctx.app.inject({ method: 'POST', url: '/api/moderation/usage/refresh', headers, payload: {} });

describe('resource usage dashboard', () => {
  it('refuses anonymous visitors, members and reviewers', async () => {
    expect((await getUsage()).statusCode).toBe(401);
    expect((await refresh()).statusCode).toBe(401);
    for (const trust of [TRUST.NEW, TRUST.MEMBER, TRUST.REVIEWER]) {
      const user = await makeUser(ctx.sql, { trust });
      const get = await getUsage(user.headers);
      expect(get.statusCode).toBe(403);
      expect(get.json()).not.toHaveProperty('providers');
      expect((await refresh(user.headers)).statusCode).toBe(403);
    }
  });

  it('shows moderators every provider, measuring what it can and saying what it cannot', async () => {
    const moderator = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const res = await getUsage(moderator.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const report = res.json<UsageReport>();
    expect(report.providers.map((p) => p.id)).toEqual(['neon', 'redis', 'r2', 'vercel']);
    const neon = report.providers.find((p) => p.id === 'neon')!;
    const size = neon.metrics.find((m) => m.id === 'neon.databaseSize')!;
    expect(size.status).toBe('ok');
    expect(size.value).toBeGreaterThan(0);
    // The test app has no Redis, no R2 and no monitoring credentials: nothing pretends to be measured.
    for (const id of ['redis', 'r2'] as const) {
      const metrics = report.providers.find((p) => p.id === id)!.metrics;
      expect(metrics.every((m) => m.status === 'not-configured' && m.value === null)).toBe(true);
    }
    expect(report.providers.find((p) => p.id === 'vercel')!.metrics.every((m) => m.status === 'unavailable')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('postgres://');
  });

  it('lets moderators refresh once a minute', async () => {
    const moderator = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const first = await refresh(moderator.headers);
    expect(first.statusCode).toBe(200);
    expect(first.json<UsageReport>().refreshAvailableAt).not.toBeNull();
    const second = await refresh(moderator.headers);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: 'rate-limited' });
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('requires our own origin for refresh (CSRF)', async () => {
    const moderator = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const res = await refresh({ ...moderator.headers, origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
  });
});
