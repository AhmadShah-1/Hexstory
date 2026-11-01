import type { UsageComparison, UsageLevel, UsageLimit, UsageMetric, UsageUnit } from '@hexstory/shared';

/** Pure helpers for the usage dashboard: comparisons, units, calendar periods. No I/O. */

export interface Thresholds {
  warningPercent: number;
  criticalPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warningPercent: 75, criticalPercent: 90 };

/** Configured limits use decimal units (GB = 10^9 bytes): the smaller reading warns earlier. */
export const BYTES_PER_GB = 1e9;
export const BYTES_PER_MB = 1e6;

const isUsable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function levelFor(percent: number, t: Thresholds): UsageLevel {
  if (percent >= t.criticalPercent) return 'critical';
  if (percent >= t.warningPercent) return 'warning';
  return 'ok';
}

/**
 * Percent used and what remains, only when it means something: a known, finite, non-negative
 * value; a finite limit above zero; and both in the same unit. Anything else gives null, so the
 * UI shows the value alone rather than a made-up percentage.
 */
export function compareToLimit(
  value: number | null | undefined,
  unit: UsageUnit,
  limit: Pick<UsageLimit, 'value' | 'unit'> | null | undefined,
  thresholds: Thresholds,
): UsageComparison | null {
  if (!isUsable(value) || value < 0) return null;
  if (!limit || limit.unit !== unit || !isUsable(limit.value) || limit.value <= 0) return null;
  const percent = (value / limit.value) * 100;
  return { percent, remaining: limit.value - value, level: levelFor(percent, thresholds) };
}

/** Recomputes the comparison (thresholds may change between deploys, cached readings don't). */
export function withComparison(metric: UsageMetric, thresholds: Thresholds): UsageMetric {
  const comparison = metric.status === 'ok' ? compareToLimit(metric.value, metric.unit, metric.limit, thresholds) : null;
  return { ...metric, comparison };
}

/** A non-negative finite number from a provider field, or null (never a guessed 0). */
export function toNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return isUsable(n) && n >= 0 ? n : null;
}

export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** `KEY:value` lines of Redis `INFO` output; section headers and blank lines are skipped. */
export function parseRedisInfo(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) fields.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return fields;
}
