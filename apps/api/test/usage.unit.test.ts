import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import type { UsageMetric } from '@hexstory/shared';
import type { Config } from '../src/config.js';
import { createMemoryCoordinator, createRedisCoordinator, type Coordinator } from '../src/coordination.js';
import type { Sql } from '../src/db.js';
import { PROVIDER_TIMEOUT_MS, fetchJson } from '../src/usage/common.js';
import { DEFAULT_THRESHOLDS, compareToLimit, levelFor, parseRedisInfo, toNumber } from '../src/usage/math.js';
import { readNeon } from '../src/usage/neon.js';
import { readR2, summarizeOperations, summarizeStorage } from '../src/usage/r2.js';
import { readRedis } from '../src/usage/redis.js';
import { createUsageService, mergeWithPrevious } from '../src/usage/service.js';
import { accountFromEndpoint, usageSettings } from '../src/usage/settings.js';

const T = DEFAULT_THRESHOLDS;
const NOW = new Date('2026-11-03T12:00:00Z');
const now = () => NOW;
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const NEON_KEY = 'neon-secret-key-123';
const CF_TOKEN = 'cf-secret-token-456';

const byId = (metrics: UsageMetric[], id: string) => {
  const m = metrics.find((x) => x.id === id);
  if (!m) throw new Error(`no metric ${id}`);
  return m;
};

/** A postgres.js stand-in: the tagged template returns the given rows (or rejects). */
const fakeSql = (result: () => Promise<unknown[]>) => vi.fn(() => result()) as unknown as Sql & ReturnType<typeof vi.fn>;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('comparing usage with a limit', () => {
  const limit = (value: number, unit: 'bytes' | 'count' = 'bytes') => ({ value, unit });

  it('gives percent and remaining for a known limit in the same unit', () => {
    expect(compareToLimit(250, 'bytes', limit(1000), T)).toEqual({ percent: 25, remaining: 750, level: 'ok' });
  });

  it('reports overuse as more than 100% with a negative remainder', () => {
    expect(compareToLimit(1200, 'bytes', limit(1000), T)).toEqual({ percent: 120, remaining: -200, level: 'critical' });
  });

  it('gives nothing when the allowance is unknown', () => {
    expect(compareToLimit(250, 'bytes', null, T)).toBeNull();
    expect(compareToLimit(250, 'bytes', undefined, T)).toBeNull();
  });

  it('never compares different units', () => {
    expect(compareToLimit(250, 'bytes', limit(1000, 'count'), T)).toBeNull();
  });

  it('ignores zero, negative and non-finite limits', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(compareToLimit(1, 'bytes', limit(bad), T)).toBeNull();
  });

  it('ignores missing, negative and non-finite values (missing is never 0)', () => {
    for (const bad of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(compareToLimit(bad, 'bytes', limit(1000), T)).toBeNull();
    expect(compareToLimit(0, 'bytes', limit(1000), T)).toEqual({ percent: 0, remaining: 1000, level: 'ok' });
  });

  it('uses the warning thresholds inclusively, defaulting to 75% and 90%', () => {
    expect(levelFor(74.9, T)).toBe('ok');
    expect(levelFor(75, T)).toBe('warning');
    expect(levelFor(89.99, T)).toBe('warning');
    expect(levelFor(90, T)).toBe('critical');
    expect(levelFor(60, { warningPercent: 50, criticalPercent: 80 })).toBe('warning');
  });

  it('reads provider numbers without inventing zeros', () => {
    expect(toNumber('42')).toBe(42);
    expect(toNumber(7)).toBe(7);
    expect(toNumber('')).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(-3)).toBeNull();
  });
});

describe('usage settings', () => {
  it('has no limits unless configured, and default thresholds', () => {
    const s = usageSettings({});
    expect(s.thresholds).toEqual({ warningPercent: 75, criticalPercent: 90 });
    expect(s.cacheMs).toBe(900_000);
    expect(s.neon.limits).toEqual({ storage: null, compute: null, transfer: null });
    expect(s.redis.limits).toEqual({ memory: null, connections: null, opsPerSecond: null });
    expect(s.r2.limits).toEqual({ storage: null, classA: null, classB: null });
    expect(s.problems).toEqual([]);
  });

  it('converts configured limits to the metric unit and marks their kind', () => {
    const s = usageSettings({
      USAGE_LIMIT_NEON_STORAGE_GB: '0.5',
      USAGE_LIMIT_REDIS_MEMORY_MB: '30',
      USAGE_LIMIT_R2_CLASS_A_MONTH: '1000000',
      USAGE_NEON_PLAN: 'paid',
    });
    expect(s.neon.limits.storage).toEqual({ value: 5e8, unit: 'bytes', kind: 'included', source: 'config', label: 'USAGE_LIMIT_NEON_STORAGE_GB' });
    expect(s.redis.limits.memory).toMatchObject({ value: 3e7, unit: 'bytes', kind: 'hard' });
    expect(s.r2.limits.classA).toMatchObject({ value: 1e6, unit: 'count', kind: 'included' });
    expect(usageSettings({ USAGE_LIMIT_NEON_STORAGE_GB: '1' }).neon.limits.storage?.kind).toBe('hard');
  });

  it('ignores and reports bad values instead of failing', () => {
    const s = usageSettings({
      USAGE_LIMIT_NEON_STORAGE_GB: 'lots',
      USAGE_LIMIT_REDIS_CONNECTIONS: '0',
      USAGE_LIMIT_R2_CLASS_B_MONTH: '-1',
      USAGE_WARN_PERCENT: '95',
      USAGE_CRITICAL_PERCENT: '90',
      USAGE_NEON_PROJECT_ID: '../../admin',
      USAGE_CLOUDFLARE_ACCOUNT_ID: 'nope',
    });
    expect(s.neon.limits.storage).toBeNull();
    expect(s.redis.limits.connections).toBeNull();
    expect(s.r2.limits.classB).toBeNull();
    expect(s.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(s.neon.projectId).toBeNull();
    expect(s.r2.accountId).toBeNull();
    expect(s.problems.length).toBe(6);
  });

  it('takes the Cloudflare account from R2_ENDPOINT', () => {
    expect(accountFromEndpoint(`https://${ACCOUNT}.r2.cloudflarestorage.com`)).toBe(ACCOUNT);
    expect(accountFromEndpoint(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`)).toBe(ACCOUNT);
    expect(accountFromEndpoint('https://example.com')).toBeNull();
    expect(accountFromEndpoint('not a url')).toBeNull();
  });
});

describe('provider requests', () => {
  it('turns timeouts, refusals and odd responses into safe messages', async () => {
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    await expect(fetchJson(timeout as typeof fetch, 'https://x')).rejects.toThrow(`No answer within ${PROVIDER_TIMEOUT_MS / 1000} s.`);
    const refused = vi.fn(async () => new Response('{"message":"invalid key neon-secret-key-123"}', { status: 401 }));
    const err = await fetchJson(refused as typeof fetch, 'https://x').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/credential was refused/);
    expect((err as Error).message).not.toContain('neon-secret');
    const html = vi.fn(async () => new Response('<html>', { status: 200 }));
    await expect(fetchJson(html as typeof fetch, 'https://x')).rejects.toThrow('could not read');
    const down = vi.fn(async () => new Response('', { status: 503 }));
    await expect(fetchJson(down as typeof fetch, 'https://x')).rejects.toThrow('HTTP 503');
  });

  it('passes an abort signal so slow providers are cut off', async () => {
    const seen = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({});
    });
    await fetchJson(seen as unknown as typeof fetch, 'https://x');
    expect(seen).toHaveBeenCalledOnce();
  });
});

// ---- Redis ----

const INFO = [
  '# Server', 'redis_version:7.4.0', 'uptime_in_seconds:3600', '',
  '# Clients', 'connected_clients:6', '',
  '# Memory', 'used_memory:15000000', 'maxmemory:0', '',
  '# Stats', 'instantaneous_ops_per_sec:12', 'evicted_keys:0', '',
].join('\r\n');

const fakeCoordinator = (info: () => Promise<string | null>): Coordinator => ({ ...createMemoryCoordinator(), info });

describe('Redis usage', () => {
  it('parses INFO text', () => {
    const f = parseRedisInfo(INFO);
    expect(f.get('used_memory')).toBe('15000000');
    expect(f.has('# Memory')).toBe(false);
  });

  it('reads memory, connections, ops/s and evictions from INFO', async () => {
    const settings = usageSettings({ USAGE_LIMIT_REDIS_MEMORY_MB: '30', USAGE_LIMIT_REDIS_CONNECTIONS: '30' });
    const metrics = await readRedis({ coordinator: fakeCoordinator(async () => INFO), settings, now });
    expect(byId(metrics, 'redis.memory')).toMatchObject({ status: 'ok', value: 15_000_000, kind: 'capacity', limit: { value: 30_000_000, source: 'config' } });
    expect(byId(metrics, 'redis.connections')).toMatchObject({ status: 'ok', value: 6, limit: { value: 30 } });
    expect(byId(metrics, 'redis.ops')).toMatchObject({ status: 'ok', value: 12, limit: null });
    const evictions = byId(metrics, 'redis.evictions');
    expect(evictions).toMatchObject({ status: 'ok', value: 0, kind: 'period' });
    expect(evictions.period?.start).toBe('2026-11-03T11:00:00.000Z');
  });

  it('uses INFO maxmemory only when set and no limit is configured', async () => {
    const withMax = INFO.replace('maxmemory:0', 'maxmemory:31457280');
    const metrics = await readRedis({ coordinator: fakeCoordinator(async () => withMax), settings: usageSettings({}), now });
    expect(byId(metrics, 'redis.memory').limit).toMatchObject({ value: 31_457_280, source: 'provider' });
    const zero = await readRedis({ coordinator: fakeCoordinator(async () => INFO), settings: usageSettings({}), now });
    expect(byId(zero, 'redis.memory').limit).toBeNull();
  });

  it('marks fields Redis did not report as unavailable, not 0', async () => {
    const metrics = await readRedis({ coordinator: fakeCoordinator(async () => 'used_memory:100'), settings: usageSettings({}), now });
    expect(byId(metrics, 'redis.evictions')).toMatchObject({ status: 'unavailable', value: null });
  });

  it('says "not configured" without Redis, and fails safely when Redis is down or slow', async () => {
    const none = await readRedis({ coordinator: createMemoryCoordinator(), settings: usageSettings({}), now });
    expect(none.every((m) => m.status === 'not-configured' && m.value === null)).toBe(true);

    const down = await readRedis({
      coordinator: fakeCoordinator(async () => {
        throw new Error('connect ECONNREFUSED redis://default:hunter2@host:6379');
      }),
      settings: usageSettings({}),
      now,
    });
    expect(down.every((m) => m.status === 'error')).toBe(true);
    expect(JSON.stringify(down)).not.toContain('hunter2');

    vi.useFakeTimers();
    const pending = readRedis({ coordinator: fakeCoordinator(() => new Promise(() => {})), settings: usageSettings({}), now });
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS + 1);
    const slow = await pending;
    expect(slow[0]).toMatchObject({ status: 'error', note: `No answer within ${PROVIDER_TIMEOUT_MS / 1000} s.` });
  });
});

// ---- Neon ----

const neonSettings = (extra: Record<string, string> = {}) =>
  usageSettings({ USAGE_NEON_API_KEY: NEON_KEY, USAGE_NEON_PROJECT_ID: 'calm-sky-123456', ...extra });

const neonFetch = (project: object, branches: object[] = [{ logical_size: 30_000_000 }, { logical_size: 20_000_000 }]) =>
  vi.fn(async (url: string) => (url.endsWith('/branches') ? jsonResponse({ branches }) : jsonResponse({ project })));

describe('Neon usage', () => {
  const sql = () => fakeSql(async () => [{ name: 'neondb', size: 12_345_678 }]);

  it('measures the database without an API key and says the rest is not configured', async () => {
    const fetchFn = vi.fn();
    const metrics = await readNeon({ sql: sql(), settings: usageSettings({}), fetch: fetchFn as unknown as typeof fetch, now });
    expect(byId(metrics, 'neon.databaseSize')).toMatchObject({ status: 'ok', value: 12_345_678, scope: 'database', scopeLabel: 'neondb', sourceKind: 'application', limit: null });
    for (const id of ['neon.projectStorage', 'neon.compute', 'neon.transfer']) expect(byId(metrics, id).status).toBe('not-configured');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads project storage, compute and transfer from the Neon API', async () => {
    const fetchFn = neonFetch({
      compute_time_seconds: 7200,
      data_transfer_bytes: 1_000_000_000,
      consumption_period_start: '2026-11-01T00:00:00Z',
      consumption_period_end: '2026-12-01T00:00:00Z',
      settings: { quota: { compute_time_seconds: 360_000 } },
    });
    const metrics = await readNeon({
      sql: sql(),
      settings: neonSettings({ USAGE_LIMIT_NEON_STORAGE_GB: '0.5', USAGE_LIMIT_NEON_TRANSFER_GB: '5' }),
      fetch: fetchFn as unknown as typeof fetch,
      now,
    });
    expect(byId(metrics, 'neon.projectStorage')).toMatchObject({ value: 50_000_000, scope: 'project', limit: { value: 5e8, source: 'config', kind: 'hard' } });
    // A customer-set quota from the API wins over configuration.
    expect(byId(metrics, 'neon.compute')).toMatchObject({ value: 2, unit: 'cu-hours', limit: { value: 100, source: 'provider', kind: 'hard' } });
    expect(byId(metrics, 'neon.compute').period).toEqual({ start: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', label: 'Neon consumption period' });
    expect(byId(metrics, 'neon.transfer')).toMatchObject({ value: 1e9, limit: { value: 5e9, source: 'config' } });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://console.neon.tech/api/v2/projects/calm-sky-123456');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${NEON_KEY}`);
  });

  it('keeps going when one source fails, without leaking the key or the response', async () => {
    const fetchFn = vi.fn(async () => new Response(`{"message":"bad key ${NEON_KEY}"}`, { status: 401 }));
    const failingSql = fakeSql(async () => {
      throw new Error('password authentication failed for postgres://u:secretpw@host/db');
    });
    const metrics = await readNeon({ sql: failingSql, settings: neonSettings(), fetch: fetchFn as unknown as typeof fetch, now });
    expect(metrics.map((m) => m.status)).toEqual(['error', 'error', 'error', 'error']);
    expect(byId(metrics, 'neon.compute').note).toMatch(/credential was refused/);
    const text = JSON.stringify(metrics);
    expect(text).not.toContain(NEON_KEY);
    expect(text).not.toContain('secretpw');
  });

  it('never turns a missing field into 0', async () => {
    const metrics = await readNeon({ sql: sql(), settings: neonSettings(), fetch: neonFetch({}, [{}]) as unknown as typeof fetch, now });
    expect(byId(metrics, 'neon.compute')).toMatchObject({ status: 'unavailable', value: null });
    expect(byId(metrics, 'neon.projectStorage')).toMatchObject({ status: 'unavailable', value: null });
  });
});

// ---- R2 ----

const r2Config = (extra: Record<string, string> = {}) =>
  usageSettings({
    STORAGE_BACKEND: 'r2',
    R2_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    R2_BUCKET: 'hexstory-images',
    R2_STAGING_BUCKET: 'hexstory-staging',
    USAGE_CLOUDFLARE_API_TOKEN: CF_TOKEN,
    ...extra,
  });

const storageRow = (bucketName: string, datetime: string, payloadSize: number, objectCount: number) => ({
  max: { payloadSize, metadataSize: 0, objectCount },
  dimensions: { bucketName, datetime },
});

const graphql = (node: string, rows: unknown[]) => jsonResponse({ data: { viewer: { accounts: [{ [node]: rows }] } }, errors: null });

describe('R2 usage', () => {
  const opsRows = [
    { sum: { requests: 100 }, dimensions: { actionType: 'PutObject', responseStatusCode: 200 } },
    { sum: { requests: 5 }, dimensions: { actionType: 'PutObject', responseStatusCode: 403 } },
    { sum: { requests: 1000 }, dimensions: { actionType: 'GetObject', responseStatusCode: 200 } },
    { sum: { requests: 7 }, dimensions: { actionType: 'GetObject', responseStatusCode: 401 } },
    { sum: { requests: 50 }, dimensions: { actionType: 'DeleteObject', responseStatusCode: 204 } },
    { sum: { requests: 3 }, dimensions: { actionType: 'SomethingNew', responseStatusCode: 200 } },
  ];

  it('classifies operations; auth failures and deletes are free', () => {
    expect(summarizeOperations(opsRows)).toEqual({ classA: 100, classB: 1000, unknown: 3 });
  });

  it('estimates GB-months from daily peaks, carrying sizes over days without samples', () => {
    const rows = [
      storageRow('a', '2026-11-03T10:00:00Z', 3e9, 3),
      storageRow('a', '2026-11-01T05:00:00Z', 1e9, 1),
      storageRow('a', '2026-11-01T01:00:00Z', 0.5e9, 1),
    ];
    const s = summarizeStorage(rows, new Date('2026-11-01T00:00:00Z'), NOW);
    // Nov 1: 1 GB (peak), Nov 2: 1 GB (carried), Nov 3: 3 GB → 5 GB-days / 30.
    expect(s.gbMonths).toBeCloseTo(5 / 30);
    expect(s.latest.get('a')).toEqual({ bytes: 3e9, objects: 3, at: '2026-11-03T10:00:00Z' });
    expect(s.latestTotal).toBe(3e9);
    expect(summarizeStorage([], new Date('2026-11-01T00:00:00Z'), NOW)).toMatchObject({ gbMonths: null, latestTotal: null });
  });

  it('is not configured without the monitoring token, or when R2 is not used', async () => {
    const fetchFn = vi.fn();
    const noToken = await readR2({ settings: r2Config({ USAGE_CLOUDFLARE_API_TOKEN: '' }), fetch: fetchFn as unknown as typeof fetch, now });
    expect(noToken.every((m) => m.status === 'not-configured')).toBe(true);
    const local = await readR2({ settings: usageSettings({ STORAGE_BACKEND: 'local' }), fetch: fetchFn as unknown as typeof fetch, now });
    expect(local.every((m) => m.status === 'not-configured')).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads bucket storage and monthly operations through GraphQL only', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      if (body.query.includes('r2StorageAdaptiveGroups')) {
        return graphql('r2StorageAdaptiveGroups', [
          storageRow('hexstory-images', '2026-11-03T11:00:00Z', 2e9, 400),
          storageRow('hexstory-staging', '2026-11-03T11:00:00Z', 1e6, 2),
          storageRow('hexstory-preview-images', '2026-11-03T11:00:00Z', 1e8, 10),
        ]);
      }
      return graphql('r2OperationsAdaptiveGroups', opsRows);
    });
    const metrics = await readR2({ settings: r2Config({ USAGE_LIMIT_R2_CLASS_A_MONTH: '1000000' }), fetch: fetchFn as unknown as typeof fetch, now });

    expect(byId(metrics, 'r2.images.storage')).toMatchObject({ status: 'ok', value: 2e9, scope: 'bucket', scopeLabel: 'hexstory-images', kind: 'capacity' });
    expect(byId(metrics, 'r2.images.objects')).toMatchObject({ value: 400 });
    expect(byId(metrics, 'r2.staging.storage')).toMatchObject({ value: 1e6, scopeLabel: 'hexstory-staging' });
    expect(byId(metrics, 'r2.account.storage')).toMatchObject({ value: 2.101e9, scope: 'account' });
    const classA = byId(metrics, 'r2.classA');
    expect(classA).toMatchObject({ value: 100, kind: 'period', scope: 'account', limit: { value: 1e6, kind: 'included' } });
    expect(classA.period).toEqual({ start: '2026-11-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z', label: 'Calendar month (UTC)' });
    expect(byId(metrics, 'r2.classB')).toMatchObject({ value: 1000, limit: null });

    for (const call of fetchFn.mock.calls) {
      const [url, init] = call as unknown as [string, RequestInit];
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${CF_TOKEN}`);
      const body = JSON.parse(String(init.body)) as { variables: { accountTag: string; start: string } };
      expect(body.variables.accountTag).toBe(ACCOUNT);
      // Never more than Cloudflare's 31-day maximum.
      expect(NOW.getTime() - Date.parse(body.variables.start)).toBeLessThanOrEqual(31 * 86_400_000);
    }
  });

  it('reports a bucket without samples as unavailable, and GraphQL errors safely', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) =>
      String(init?.body).includes('r2StorageAdaptiveGroups')
        ? graphql('r2StorageAdaptiveGroups', [])
        : jsonResponse({ data: null, errors: [{ message: `not authorized for ${ACCOUNT} token ${CF_TOKEN}` }] }),
    );
    const metrics = await readR2({ settings: r2Config(), fetch: fetchFn as unknown as typeof fetch, now });
    expect(byId(metrics, 'r2.images.storage')).toMatchObject({ status: 'unavailable', value: null });
    expect(byId(metrics, 'r2.account.storage')).toMatchObject({ status: 'unavailable', value: null });
    expect(byId(metrics, 'r2.classA')).toMatchObject({ status: 'error', value: null });
    expect(JSON.stringify(metrics)).not.toContain(CF_TOKEN);
  });
});

// ---- Caching, staleness and refresh ----

describe('usage service', () => {
  const metric = (over: Partial<UsageMetric>): UsageMetric => ({
    id: 'x', label: 'X', kind: 'capacity', scope: 'database', scopeLabel: null, status: 'ok', value: 5, unit: 'bytes', limit: null,
    comparison: null, period: null, measuredAt: '2026-11-03T10:00:00.000Z', stale: false, source: 's', sourceKind: 'application',
    approximate: false, note: null, ...over,
  });

  it('keeps the last good value as stale when a reading fails', () => {
    const merged = mergeWithPrevious([metric({ status: 'error', value: null, measuredAt: null, note: 'No answer within 4 s.' })], [metric({})]);
    expect(merged[0]).toMatchObject({ status: 'ok', value: 5, stale: true, measuredAt: '2026-11-03T10:00:00.000Z', note: 'No answer within 4 s.' });
    expect(mergeWithPrevious([metric({ status: 'error', value: null })], null)[0]).toMatchObject({ status: 'error', value: null });
    // Not-configured is a state, not a failure: never replaced by an old value.
    expect(mergeWithPrevious([metric({ status: 'not-configured', value: null })], [metric({})])[0]?.status).toBe('not-configured');
  });

  const config = { NODE_ENV: 'test', STORAGE_BACKEND: 'local', USAGE_LIMIT_NEON_STORAGE_GB: 'x' } as unknown as Config;

  it('caches readings, rate-limits refresh, and marks failures stale', async () => {
    // The coordinator's locks and expiries follow the system clock, so move that too.
    vi.useFakeTimers({ toFake: ['Date'] });
    let clock = NOW.getTime();
    vi.setSystemTime(clock);
    let fail = false;
    const sql = fakeSql(async () => {
      if (fail) throw new Error('boom');
      return [{ name: 'neondb', size: 1000 }];
    });
    const service = createUsageService({ config, sql, coordinator: createMemoryCoordinator(), now: () => new Date(clock), fetch: vi.fn() as unknown as typeof fetch });

    const first = await service.report();
    expect(first.providers.map((p) => p.id)).toEqual(['neon', 'redis', 'r2', 'vercel']);
    expect(first.configProblems).toHaveLength(1);
    expect(first.thresholds).toEqual({ warningPercent: 75, criticalPercent: 90 });
    const vercel = first.providers.find((p) => p.id === 'vercel')!;
    expect(vercel.metrics.every((m) => m.status === 'unavailable' && m.value === null)).toBe(true);
    expect(vercel.dashboardUrl).toMatch(/^https:\/\/vercel\.com\//);

    await service.report();
    expect(sql).toHaveBeenCalledTimes(1); // served from the cache

    const refreshed = await service.refresh();
    expect(refreshed.ok).toBe(true);
    expect(sql).toHaveBeenCalledTimes(2);
    const again = await service.refresh();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(Date.parse(again.retryAt)).toBeGreaterThan(clock);

    fail = true;
    clock += 16 * 60_000; // past the 15-minute cache
    vi.setSystemTime(clock);
    const later = await service.report();
    const size = later.providers[0]!.metrics.find((m) => m.id === 'neon.databaseSize')!;
    expect(size).toMatchObject({ status: 'ok', value: 1000, stale: true, measuredAt: NOW.toISOString() });
    expect(size.note).not.toContain('boom');
  });

  it('computes comparisons when serving, with the configured thresholds', async () => {
    const sql = fakeSql(async () => [{ name: 'neondb', size: 800 }]);
    const coordinator = {
      ...createMemoryCoordinator(),
      info: async () => 'used_memory:24000000\r\nconnected_clients:2\r\ninstantaneous_ops_per_sec:1\r\nevicted_keys:0',
    };
    const service = createUsageService({
      config: { ...config, USAGE_LIMIT_NEON_STORAGE_GB: undefined, USAGE_LIMIT_REDIS_MEMORY_MB: '30', USAGE_WARN_PERCENT: '70', USAGE_CRITICAL_PERCENT: '80' } as unknown as Config,
      sql,
      coordinator,
      now,
    });
    const report = await service.report();
    const memory = report.providers.find((p) => p.id === 'redis')!.metrics.find((m) => m.id === 'redis.memory')!;
    expect(memory.comparison).toEqual({ percent: 80, remaining: 6_000_000, level: 'critical' });
    // Database size is never compared with the (project-wide) storage allowance.
    expect(report.providers[0]!.metrics[0]!.comparison).toBeNull();
  });
});

describe('coordinator cache for usage readings', () => {
  it('stores small JSON values with an expiry in memory', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const c = createMemoryCoordinator();
    const value = { a: [1, 2] };
    await c.setJson('k', value, 1000);
    const read = await c.getJson<typeof value>('k');
    expect(read).toEqual(value);
    read!.a.push(3); // callers get copies
    expect(await c.getJson('k')).toEqual({ a: [1, 2] });
    vi.setSystemTime(Date.now() + 1001);
    expect(await c.getJson('k')).toBeNull();
    expect(await c.info()).toBeNull();
  });

  it('stores them under the environment prefix in Redis and reads INFO over the same connection', async () => {
    const client = new RedisMock() as unknown as Redis;
    const c = createRedisCoordinator(client, new RedisMock() as unknown as Redis, 'hx:test-usage:');
    await c.setJson('usage:x', { ok: true }, 60_000);
    expect(await c.getJson('usage:x')).toEqual({ ok: true });
    expect(await client.get('hx:test-usage:usage:x')).toBe('{"ok":true}');
    expect(await client.pttl('hx:test-usage:usage:x')).toBeGreaterThan(0);
    expect(await c.getJson('usage:missing')).toBeNull();
    expect(typeof (await c.info())).toBe('string');
  });
});
