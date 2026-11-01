import type { UsageLimit, UsageLimitKind, UsageUnit } from '@hexstory/shared';
import type { Config } from '../config.js';
import { BYTES_PER_GB, BYTES_PER_MB, DEFAULT_THRESHOLDS, type Thresholds } from './math.js';

/**
 * The dashboard's settings, parsed from the optional USAGE_* variables. Bad values never stop the
 * site: they are ignored and listed in `problems`, which the dashboard shows to moderators.
 * Allowances are never assumed: a limit exists only when a variable sets it (or a provider API
 * reports it, see the adapters).
 */
export interface UsageSettings {
  cacheMs: number;
  thresholds: Thresholds;
  problems: string[];
  neon: {
    apiKey: string | null;
    projectId: string | null;
    /** Free: Neon suspends compute / refuses writes at the limits. Paid: overage is billed. */
    limitKind: UsageLimitKind;
    limits: { storage: UsageLimit | null; compute: UsageLimit | null; transfer: UsageLimit | null };
  };
  redis: { limits: { memory: UsageLimit | null; connections: UsageLimit | null; opsPerSecond: UsageLimit | null } };
  r2: {
    apiToken: string | null;
    accountId: string | null;
    buckets: { images: string | null; staging: string | null };
    limits: { storage: UsageLimit | null; classA: UsageLimit | null; classB: UsageLimit | null };
  };
}

export const DEFAULT_CACHE_SECONDS = 900;
const NEON_PROJECT_ID = /^[a-z0-9-]{1,64}$/i;
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/i;

type Env = Partial<Record<keyof Config, unknown>>;

export function usageSettings(config: Env): UsageSettings {
  const problems: string[] = [];
  const str = (key: keyof Config): string | null => {
    const v = config[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  /** A positive finite number, or null (reported when set but invalid). */
  const positive = (key: keyof Config, { max = Infinity, integer = false } = {}): number | null => {
    const raw = str(key);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) {
      problems.push(`${key} must be a positive ${integer ? 'whole ' : ''}number${max < Infinity ? ` up to ${max}` : ''}; it is ignored.`);
      return null;
    }
    return n;
  };
  const limit = (key: keyof Config, unit: UsageUnit, kind: UsageLimitKind, scale = 1): UsageLimit | null => {
    const n = positive(key);
    return n === null ? null : { value: n * scale, unit, kind, source: 'config', label: key };
  };

  const cacheSeconds = positive('USAGE_CACHE_SECONDS', { max: 86_400, integer: true });
  if (cacheSeconds !== null && cacheSeconds < 60) problems.push('USAGE_CACHE_SECONDS below 60 is raised to 60.');

  let thresholds = { ...DEFAULT_THRESHOLDS };
  const warning = positive('USAGE_WARN_PERCENT', { max: 100 });
  const critical = positive('USAGE_CRITICAL_PERCENT', { max: 100 });
  const candidate = { warningPercent: warning ?? thresholds.warningPercent, criticalPercent: critical ?? thresholds.criticalPercent };
  if (candidate.warningPercent < candidate.criticalPercent) thresholds = candidate;
  else problems.push('USAGE_WARN_PERCENT must be below USAGE_CRITICAL_PERCENT; using 75 and 90.');

  const plan = str('USAGE_NEON_PLAN')?.toLowerCase() ?? 'free';
  if (plan !== 'free' && plan !== 'paid') problems.push('USAGE_NEON_PLAN must be "free" or "paid"; assuming free.');
  const neonKind: UsageLimitKind = plan === 'paid' ? 'included' : 'hard';

  let projectId = str('USAGE_NEON_PROJECT_ID');
  if (projectId && !NEON_PROJECT_ID.test(projectId)) {
    problems.push('USAGE_NEON_PROJECT_ID doesn’t look like a Neon project ID; it is ignored.');
    projectId = null;
  }

  let accountId = str('USAGE_CLOUDFLARE_ACCOUNT_ID') ?? accountFromEndpoint(str('R2_ENDPOINT'));
  if (accountId && !CLOUDFLARE_ACCOUNT_ID.test(accountId)) {
    problems.push('USAGE_CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID; it is ignored.');
    accountId = null;
  }
  const r2InUse = config.STORAGE_BACKEND === 'r2';

  return {
    cacheMs: Math.max(60, cacheSeconds ?? DEFAULT_CACHE_SECONDS) * 1000,
    thresholds,
    problems,
    neon: {
      apiKey: str('USAGE_NEON_API_KEY'),
      projectId,
      limitKind: neonKind,
      limits: {
        storage: limit('USAGE_LIMIT_NEON_STORAGE_GB', 'bytes', neonKind, BYTES_PER_GB),
        compute: limit('USAGE_LIMIT_NEON_COMPUTE_CU_HOURS', 'cu-hours', neonKind),
        transfer: limit('USAGE_LIMIT_NEON_TRANSFER_GB', 'bytes', neonKind, BYTES_PER_GB),
      },
    },
    redis: {
      // Redis Cloud refuses writes (no eviction), connections and throughput beyond the plan: hard limits.
      limits: {
        memory: limit('USAGE_LIMIT_REDIS_MEMORY_MB', 'bytes', 'hard', BYTES_PER_MB),
        connections: limit('USAGE_LIMIT_REDIS_CONNECTIONS', 'count', 'hard'),
        opsPerSecond: limit('USAGE_LIMIT_REDIS_OPS_PER_SEC', 'ops-per-second', 'hard'),
      },
    },
    r2: {
      apiToken: str('USAGE_CLOUDFLARE_API_TOKEN'),
      accountId,
      buckets: { images: r2InUse ? str('R2_BUCKET') : null, staging: r2InUse ? str('R2_STAGING_BUCKET') : null },
      // R2's free tier is an allowance; use beyond it is billed.
      limits: {
        storage: limit('USAGE_LIMIT_R2_STORAGE_GB_MONTH', 'gb-months', 'included'),
        classA: limit('USAGE_LIMIT_R2_CLASS_A_MONTH', 'count', 'included'),
        classB: limit('USAGE_LIMIT_R2_CLASS_B_MONTH', 'count', 'included'),
      },
    },
  };
}

/** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (or `.eu.`) → the account ID. */
export function accountFromEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const host = new URL(endpoint).hostname;
    if (!host.endsWith('.r2.cloudflarestorage.com')) return null;
    const id = host.split('.')[0]!;
    return CLOUDFLARE_ACCOUNT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}
