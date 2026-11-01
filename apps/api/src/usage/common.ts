import type { UsageLimit, UsageMetric, UsagePeriod } from '@hexstory/shared';

/** Each provider call gets this long; one slow provider never holds up the others for longer. */
export const PROVIDER_TIMEOUT_MS = 4_000;

export type FetchFn = typeof fetch;

/**
 * An error whose message is safe to show moderators. Provider responses, credentials and
 * connection details never go into it; anything unexpected becomes a generic message.
 */
export class ProviderError extends Error {
  readonly safe = true;
}

export function safeMessage(err: unknown): string {
  return err instanceof ProviderError ? err.message : 'Reading this failed unexpectedly. Details are in the server log.';
}

/** Rejects with a ProviderError when `promise` takes longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number = PROVIDER_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(`No answer within ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** GET/POST JSON with a timeout; maps every failure to a ProviderError with a fixed, safe message. */
export async function fetchJson(fetchFn: FetchFn, url: string, init: RequestInit = {}, ms = PROVIDER_TIMEOUT_MS): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError(`No answer within ${ms / 1000} s.`);
    throw new ProviderError('Could not reach the provider.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('The monitoring credential was refused. Check that it is valid and has the documented permission.');
  }
  if (res.status === 429) throw new ProviderError('The provider is rate-limiting requests. Try again later.');
  if (!res.ok) throw new ProviderError(`The provider answered with HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new ProviderError('The provider sent a response we could not read.');
  }
}

/** Everything about a metric except its reading. */
export type MetricBase = Omit<UsageMetric, 'status' | 'value' | 'comparison' | 'measuredAt' | 'stale' | 'note' | 'limit' | 'period'> & {
  limit?: UsageLimit | null;
  period?: UsagePeriod | null;
  note?: string | null;
};

/** A reading. A value the provider didn't report becomes "unavailable", never 0. */
export function measured(base: MetricBase, value: number | null, measuredAt: Date, extra: Partial<MetricBase> = {}): UsageMetric {
  const b = { ...base, ...extra };
  if (value === null) return missing(b, 'unavailable', 'The provider did not report this value.');
  return {
    ...b,
    limit: b.limit ?? null,
    period: b.period ?? null,
    note: b.note ?? null,
    status: 'ok',
    value,
    comparison: null,
    measuredAt: measuredAt.toISOString(),
    stale: false,
  };
}

export function missing(base: MetricBase, status: 'not-configured' | 'unavailable' | 'error', note: string): UsageMetric {
  return {
    ...base,
    limit: base.limit ?? null,
    period: base.period ?? null,
    status,
    value: null,
    comparison: null,
    measuredAt: null,
    stale: false,
    note,
  };
}
