/**
 * Moderators' resource usage dashboard (`GET /api/moderation/usage`). Every number says what it
 * measures, where it came from and how fresh it is; missing data is `null`, never 0.
 */

export type UsageProviderId = 'neon' | 'redis' | 'r2' | 'vercel';

/**
 * Units are kept raw; the browser formats them. Limits are converted to the metric's unit, and a
 * limit in another unit is never compared. `gb-months` uses GB = 10^9 bytes (as configured limits do).
 */
export type UsageUnit = 'bytes' | 'count' | 'ops-per-second' | 'cu-hours' | 'cpu-hours' | 'gb-hours' | 'gb-months';

/**
 * - `capacity`: how much is in use right now (storage, memory, connections). Shown under "Now".
 * - `period`: cumulative use since a start date (monthly operations, compute hours). Shown under "This period".
 */
export type UsageKind = 'capacity' | 'period';

/** What the metric covers. A bucket's size is not comparable with an account-wide allowance. */
export type UsageScope = 'database' | 'project' | 'bucket' | 'account' | 'instance';

/**
 * - `hard`: the provider stops, throttles or pauses at the limit.
 * - `included`: an allowance in the plan; use beyond it is billed.
 */
export type UsageLimitKind = 'hard' | 'included';

/**
 * - `ok`: measured (possibly stale, see `stale`).
 * - `not-configured`: needs an optional monitoring credential or setting (see DEPLOYMENT.md).
 * - `unavailable`: no API offers it for our plan; see the provider's dashboard.
 * - `error`: the last attempt failed and there is no earlier reading.
 */
export type UsageMetricStatus = 'ok' | 'not-configured' | 'unavailable' | 'error';

export type UsageLevel = 'ok' | 'warning' | 'critical';

export interface UsageLimit {
  value: number;
  unit: UsageUnit;
  kind: UsageLimitKind;
  /** `provider`: reported by the provider's API; `config`: from a USAGE_LIMIT_* variable. */
  source: 'provider' | 'config';
  /** What the limit is, e.g. "USAGE_LIMIT_R2_CLASS_A_MONTH" or "Neon project quota". */
  label: string;
}

/** Only present when value and limit are both known, finite, in the same unit and the limit is > 0. */
export interface UsageComparison {
  /** May exceed 100. */
  percent: number;
  /** Negative when over the limit. */
  remaining: number;
  level: UsageLevel;
}

export interface UsagePeriod {
  start: string | null;
  /** When the counter starts again, if known. */
  resetsAt: string | null;
  /** Plain words, e.g. "Calendar month (UTC)" or "Since Redis last restarted". */
  label: string;
}

export interface UsageMetric {
  /** Stable id, e.g. `r2.classA`. */
  id: string;
  label: string;
  kind: UsageKind;
  scope: UsageScope;
  /** Which database/bucket/project, when that is not obvious (bucket names, never connection details). */
  scopeLabel: string | null;
  status: UsageMetricStatus;
  value: number | null;
  unit: UsageUnit;
  limit: UsageLimit | null;
  comparison: UsageComparison | null;
  period: UsagePeriod | null;
  /** When this value was measured by us (or reported by the provider). */
  measuredAt: string | null;
  /** True when the latest attempt failed and this is an older reading. */
  stale: boolean;
  /** Where the number comes from, e.g. "Postgres pg_database_size()". */
  source: string;
  /** Application measurement (our own query) or provider usage/billing data. */
  sourceKind: 'application' | 'provider';
  approximate: boolean;
  /** Caveats, or why the metric is unavailable / failed. Always safe to show. */
  note: string | null;
}

export interface ProviderUsage {
  id: UsageProviderId;
  name: string;
  /** Where to see the provider's own numbers. */
  dashboardUrl: string;
  /** When we last tried to read this provider. */
  checkedAt: string | null;
  metrics: UsageMetric[];
}

export interface UsageReport {
  providers: ProviderUsage[];
  thresholds: { warningPercent: number; criticalPercent: number };
  /** Readings are reused for this long before the providers are asked again. */
  cacheSeconds: number;
  /** USAGE_* settings that were invalid and ignored. Safe to show. */
  configProblems: string[];
  /** Earliest time a manual refresh is accepted again (null: now). */
  refreshAvailableAt: string | null;
  generatedAt: string;
}
