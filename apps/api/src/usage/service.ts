import type { ProviderUsage, UsageMetric, UsageProviderId, UsageReport } from '@hexstory/shared';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Sql } from '../db.js';
import type { FetchFn } from './common.js';
import { withComparison } from './math.js';
import { readNeon } from './neon.js';
import { readR2 } from './r2.js';
import { readRedis } from './redis.js';
import { usageSettings, type UsageSettings } from './settings.js';
import { readVercel } from './vercel.js';

/** One manual refresh per minute, across every instance. */
export const REFRESH_INTERVAL_MS = 60_000;
/** After a failed reading, try again sooner than the normal cache time. */
const RETRY_AFTER_ERROR_MS = 60_000;
/** Last good readings are kept this long so a failure can show them as stale. */
const KEEP_READINGS_MS = 7 * 86_400_000;
/** Stops several instances asking the same provider at once. */
const FETCH_LOCK_MS = 15_000;

const CACHE_KEY = (id: UsageProviderId) => `usage:v1:${id}`;
const REFRESHED_KEY = 'usage:v1:refreshed';

interface CacheEntry {
  usage: ProviderUsage;
}

type Reader = () => Promise<UsageMetric[]>;

const PROVIDERS: { id: UsageProviderId; name: string; dashboardUrl: (s: UsageSettings) => string }[] = [
  {
    id: 'neon',
    name: 'Neon Postgres',
    dashboardUrl: (s) => (s.neon.projectId ? `https://console.neon.tech/app/projects/${s.neon.projectId}` : 'https://console.neon.tech/'),
  },
  { id: 'redis', name: 'Redis Cloud', dashboardUrl: () => 'https://cloud.redis.io/' },
  {
    id: 'r2',
    name: 'Cloudflare R2',
    dashboardUrl: (s) => (s.r2.accountId ? `https://dash.cloudflare.com/${s.r2.accountId}/r2/overview` : 'https://dash.cloudflare.com/'),
  },
  { id: 'vercel', name: 'Vercel', dashboardUrl: () => 'https://vercel.com/dashboard' },
];

/**
 * Where a reading failed but an earlier one succeeded, keep the earlier value, marked stale with its
 * original time and the new failure as its note. Pure, for tests.
 */
export function mergeWithPrevious(fresh: UsageMetric[], previous: UsageMetric[] | null | undefined): UsageMetric[] {
  const prev = new Map((previous ?? []).map((m) => [m.id, m]));
  return fresh.map((m) => {
    if (m.status !== 'error') return m;
    const old = prev.get(m.id);
    if (!old || old.status !== 'ok' || old.value === null) return m;
    return { ...old, stale: true, note: m.note };
  });
}

export interface UsageServiceDeps {
  config: Config;
  sql: Sql;
  coordinator: Coordinator;
  fetch?: FetchFn;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * Reads every provider at most once per cache period (shared through the coordinator, so all
 * Vercel instances reuse one reading), independently and with short timeouts. Nothing runs on a
 * timer: providers are only asked when a moderator opens the dashboard or presses Refresh.
 */
export function createUsageService(deps: UsageServiceDeps) {
  const settings = usageSettings(deps.config);
  const now = deps.now ?? (() => new Date());
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => {});
  const { coordinator } = deps;

  const readers: Record<UsageProviderId, Reader> = {
    neon: () => readNeon({ sql: deps.sql, settings, fetch: fetchFn, now }),
    redis: () => readRedis({ coordinator, settings, now }),
    r2: () => readR2({ settings, fetch: fetchFn, now }),
    vercel: () => readVercel(),
  };

  // The cache is best effort: if Redis is down, read the providers directly.
  const getCached = (id: UsageProviderId) => coordinator.getJson<CacheEntry>(CACHE_KEY(id)).catch(() => null);
  const claim = (key: string, ms: number) => coordinator.claim(key, ms).catch(() => true);

  const isFresh = (entry: CacheEntry) => {
    const checked = entry.usage.checkedAt ? Date.parse(entry.usage.checkedAt) : NaN;
    if (Number.isNaN(checked)) return false;
    const failed = entry.usage.metrics.some((m) => m.status === 'error' || m.stale);
    return now().getTime() - checked < (failed ? Math.min(RETRY_AFTER_ERROR_MS, settings.cacheMs) : settings.cacheMs);
  };

  async function readProvider(p: (typeof PROVIDERS)[number], force: boolean): Promise<ProviderUsage> {
    const cached = await getCached(p.id);
    if (cached && !force && isFresh(cached)) return cached.usage;
    // Another instance is already asking this provider: show what we have rather than ask twice.
    if (cached && !(await claim(`usage:v1:lock:${p.id}`, FETCH_LOCK_MS))) return cached.usage;

    let metrics: UsageMetric[];
    try {
      metrics = mergeWithPrevious(await readers[p.id](), cached?.usage.metrics);
    } catch (err) {
      // Adapters report their own failures per metric; this is a bug guard.
      log(`usage: reading ${p.id} failed`, err);
      metrics = (cached?.usage.metrics ?? []).map((m) => (m.status === 'ok' ? { ...m, stale: true } : m));
    }
    for (const m of metrics) if (m.status === 'error') log(`usage: ${m.id}: ${m.note ?? 'failed'}`);
    const usage: ProviderUsage = { id: p.id, name: p.name, dashboardUrl: p.dashboardUrl(settings), checkedAt: now().toISOString(), metrics };
    await coordinator.setJson(CACHE_KEY(p.id), { usage } satisfies CacheEntry, KEEP_READINGS_MS).catch((err) => log('usage: cache write failed', err));
    return usage;
  }

  async function refreshAvailableAt(): Promise<string | null> {
    const last = await coordinator.getJson<{ at: string }>(REFRESHED_KEY).catch(() => null);
    if (!last) return null;
    const next = Date.parse(last.at) + REFRESH_INTERVAL_MS;
    return next > now().getTime() ? new Date(next).toISOString() : null;
  }

  async function report(force = false): Promise<UsageReport> {
    const providers = await Promise.all(PROVIDERS.map((p) => readProvider(p, force)));
    return {
      providers: providers.map((p) => ({ ...p, metrics: p.metrics.map((m) => withComparison(m, settings.thresholds)) })),
      thresholds: settings.thresholds,
      cacheSeconds: settings.cacheMs / 1000,
      configProblems: settings.problems,
      refreshAvailableAt: await refreshAvailableAt(),
      generatedAt: now().toISOString(),
    };
  }

  return {
    settings,
    report: () => report(false),
    /** Re-reads every provider now, unless someone refreshed within the last minute. */
    async refresh(): Promise<{ ok: true; report: UsageReport } | { ok: false; retryAt: string }> {
      if (!(await claim('usage:v1:refresh', REFRESH_INTERVAL_MS))) {
        return { ok: false, retryAt: (await refreshAvailableAt()) ?? new Date(now().getTime() + REFRESH_INTERVAL_MS).toISOString() };
      }
      await coordinator.setJson(REFRESHED_KEY, { at: now().toISOString() }, REFRESH_INTERVAL_MS).catch(() => {});
      return { ok: true, report: await report(true) };
    },
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
