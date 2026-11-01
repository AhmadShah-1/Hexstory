import type { UsageMetric, UsagePeriod } from '@hexstory/shared';
import { ProviderError, fetchJson, measured, missing, safeMessage, type FetchFn, type MetricBase } from './common.js';
import { BYTES_PER_GB, startOfMonthUtc, startOfNextMonthUtc, toNumber } from './math.js';
import type { UsageSettings } from './settings.js';

export const CLOUDFLARE_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

/** R2 pricing (developers.cloudflare.com/r2/pricing): which operations count as Class A / B. Deletes and aborts are free. */
export const CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption',
  'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
export const CLASS_B = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);
export const FREE_OPERATIONS = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

/** Cloudflare's GraphQL row limit; reaching it means the answer may be cut short. */
const ROW_LIMIT = 10_000;
const DAY_MS = 86_400_000;
/** Adaptive datasets accept at most a 31-day range. */
const MAX_RANGE_MS = 31 * DAY_MS - 60_000;

const STORAGE_QUERY = `query R2Storage($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2StorageAdaptiveGroups(limit: ${ROW_LIMIT}, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [datetime_DESC]) {
      max { objectCount payloadSize metadataSize }
      dimensions { datetime bucketName }
    }
  } }
}`;

const OPERATIONS_QUERY = `query R2Operations($accountTag: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    r2OperationsAdaptiveGroups(limit: ${ROW_LIMIT}, filter: { datetime_geq: $start, datetime_leq: $end }) {
      sum { requests }
      dimensions { actionType responseStatusCode }
    }
  } }
}`;

export interface StorageRow {
  max?: { objectCount?: unknown; payloadSize?: unknown; metadataSize?: unknown };
  dimensions?: { datetime?: unknown; bucketName?: unknown };
}
export interface OperationRow {
  sum?: { requests?: unknown };
  dimensions?: { actionType?: unknown; responseStatusCode?: unknown };
}

const SAMPLED = 'Cloudflare analytics are sampled when volumes are high, so treat these as estimates rather than invoice figures.';
const MONTH_NOTE = 'Counted per calendar month (UTC); Cloudflare doesn’t document whether its monthly allowance uses the same boundaries.';

const bucketBase = (id: string, label: string, unit: 'bytes' | 'count', bucket: string | null): MetricBase => ({
  id, label, kind: 'capacity', scope: 'bucket', scopeLabel: bucket, unit,
  source: unit === 'bytes' ? 'Cloudflare GraphQL r2StorageAdaptiveGroups (payload + metadata)' : 'Cloudflare GraphQL r2StorageAdaptiveGroups objectCount',
  sourceKind: 'provider', approximate: false,
});

function bases(settings: UsageSettings, period: UsagePeriod) {
  const { images, staging } = settings.r2.buckets;
  const { limits } = settings.r2;
  return {
    imagesStorage: bucketBase('r2.images.storage', 'Images bucket size', 'bytes', images),
    imagesObjects: bucketBase('r2.images.objects', 'Images bucket objects', 'count', images),
    stagingStorage: bucketBase('r2.staging.storage', 'Staging bucket size', 'bytes', staging),
    stagingObjects: bucketBase('r2.staging.objects', 'Staging bucket objects', 'count', staging),
    accountStorage: {
      id: 'r2.account.storage', label: 'All buckets in the account', kind: 'capacity', scope: 'account', scopeLabel: null, unit: 'bytes',
      source: 'Cloudflare GraphQL r2StorageAdaptiveGroups', sourceKind: 'provider', approximate: false,
    } satisfies MetricBase,
    storageMonth: {
      id: 'r2.storageMonth', label: 'Storage this month', kind: 'period', scope: 'account', scopeLabel: null, unit: 'gb-months',
      source: 'Estimated from Cloudflare GraphQL r2StorageAdaptiveGroups (daily peaks ÷ 30)', sourceKind: 'provider', approximate: true,
      limit: limits.storage, period,
    } satisfies MetricBase,
    classA: {
      id: 'r2.classA', label: 'Class A operations (writes, lists)', kind: 'period', scope: 'account', scopeLabel: null, unit: 'count',
      source: 'Cloudflare GraphQL r2OperationsAdaptiveGroups', sourceKind: 'provider', approximate: true, limit: limits.classA, period,
    } satisfies MetricBase,
    classB: {
      id: 'r2.classB', label: 'Class B operations (reads)', kind: 'period', scope: 'account', scopeLabel: null, unit: 'count',
      source: 'Cloudflare GraphQL r2OperationsAdaptiveGroups', sourceKind: 'provider', approximate: true, limit: limits.classB, period,
    } satisfies MetricBase,
  };
}

/** Reads `data.viewer.accounts[0].<node>` and turns GraphQL-level errors into a safe message. */
function nodeRows<T>(body: unknown, node: string): T[] {
  const b = body as { data?: { viewer?: { accounts?: Record<string, unknown>[] } }; errors?: unknown[] } | null;
  if (b?.errors?.length) throw new ProviderError('Cloudflare refused the analytics query. Check the token’s Account Analytics: Read permission and the account ID.');
  const accounts = b?.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) throw new ProviderError('Cloudflare sent a response we could not read.');
  if (accounts.length === 0) throw new ProviderError('Cloudflare returned no data for this account ID.');
  const rows = accounts[0]?.[node];
  if (!Array.isArray(rows)) throw new ProviderError('Cloudflare sent a response we could not read.');
  return rows as T[];
}

const rowBytes = (r: StorageRow) => {
  const payload = toNumber(r.max?.payloadSize);
  return payload === null ? null : payload + (toNumber(r.max?.metadataSize) ?? 0);
};

/**
 * Latest size per bucket, and the month's storage as R2 bills it: the average of each day's peak
 * over a 30-day period ("GB-month"), so far this month. Days without a sample carry the last known
 * size forward. Pure, for tests.
 */
export function summarizeStorage(rows: StorageRow[], monthStart: Date, now: Date) {
  const latest = new Map<string, { bytes: number | null; objects: number | null; at: string }>();
  const daily = new Map<string, Map<string, number>>(); // bucket -> day -> peak bytes
  for (const r of rows) {
    const bucket = r.dimensions?.bucketName;
    const at = r.dimensions?.datetime;
    if (typeof bucket !== 'string' || typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue;
    const bytes = rowBytes(r);
    const prev = latest.get(bucket);
    if (!prev || Date.parse(at) > Date.parse(prev.at)) latest.set(bucket, { bytes, objects: toNumber(r.max?.objectCount), at });
    if (bytes !== null) {
      const day = new Date(at).toISOString().slice(0, 10);
      const days = daily.get(bucket) ?? new Map<string, number>();
      days.set(day, Math.max(days.get(day) ?? 0, bytes));
      daily.set(bucket, days);
    }
  }

  let byteDays = 0;
  for (const days of daily.values()) {
    const known = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
    let i = 0;
    let carry: number | null = null;
    for (let t = monthStart.getTime(); t <= now.getTime(); t += DAY_MS) {
      const day = new Date(t).toISOString().slice(0, 10);
      // The latest sampled day up to this one (the day itself when sampled).
      while (i < known.length && known[i]![0] <= day) carry = known[i++]![1];
      // Days before the first sample take the earliest sample.
      byteDays += carry ?? known[0]?.[1] ?? 0;
    }
  }
  const latestTotal = [...latest.values()].reduce<number | null>((sum, l) => (sum === null || l.bytes === null ? null : sum + l.bytes), latest.size ? 0 : null);
  return { latest, gbMonths: daily.size ? byteDays / BYTES_PER_GB / 30 : null, latestTotal };
}

/** Class A/B request counts. Requests refused at authentication (401/403) aren't billed. Pure, for tests. */
export function summarizeOperations(rows: OperationRow[]) {
  let classA = 0;
  let classB = 0;
  let unknown = 0;
  for (const r of rows) {
    const n = toNumber(r.sum?.requests) ?? 0;
    const type = r.dimensions?.actionType;
    const status = Number(r.dimensions?.responseStatusCode);
    if (status === 401 || status === 403) continue;
    if (typeof type === 'string' && CLASS_A.has(type)) classA += n;
    else if (typeof type === 'string' && CLASS_B.has(type)) classB += n;
    else if (!(typeof type === 'string' && FREE_OPERATIONS.has(type))) unknown += n;
  }
  return { classA, classB, unknown };
}

/**
 * Cloudflare R2 through the GraphQL Analytics API, with a separate token that has only
 * Account Analytics: Read. No object listing: storage comes from Cloudflare's own sampling.
 */
export async function readR2(deps: { settings: UsageSettings; fetch: FetchFn; now: () => Date }): Promise<UsageMetric[]> {
  const { settings } = deps;
  const now = deps.now();
  const monthStart = startOfMonthUtc(now);
  const period: UsagePeriod = { start: monthStart.toISOString(), resetsAt: startOfNextMonthUtc(now).toISOString(), label: 'Calendar month (UTC)' };
  const b = bases(settings, period);
  const all = Object.values(b);

  if (settings.r2.buckets.images === null && settings.r2.buckets.staging === null) {
    return all.map((m) => missing(m, 'not-configured', 'This deployment doesn’t use R2 (STORAGE_BACKEND is not r2).'));
  }
  const { apiToken, accountId } = settings.r2;
  if (!apiToken || !accountId) {
    return all.map((m) =>
      missing(m, 'not-configured', 'Optional: set USAGE_CLOUDFLARE_API_TOKEN (Account Analytics: Read). The account ID comes from R2_ENDPOINT or USAGE_CLOUDFLARE_ACCOUNT_ID.'),
    );
  }

  const query = (q: string, start: Date) =>
    fetchJson(deps.fetch, CLOUDFLARE_GRAPHQL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { accountTag: accountId, start: start.toISOString(), end: now.toISOString() } }),
    });
  // Storage: from a day before the month (to know the size on day 1), within the 31-day maximum.
  const storageStart = new Date(Math.max(monthStart.getTime() - DAY_MS, now.getTime() - MAX_RANGE_MS));
  const [storage, operations] = await Promise.allSettled([
    query(STORAGE_QUERY, storageStart).then((body) => nodeRows<StorageRow>(body, 'r2StorageAdaptiveGroups')),
    query(OPERATIONS_QUERY, monthStart).then((body) => nodeRows<OperationRow>(body, 'r2OperationsAdaptiveGroups')),
  ]);

  const metrics: UsageMetric[] = [];
  if (storage.status === 'fulfilled') {
    const rows = storage.value;
    const s = summarizeStorage(rows, monthStart, now);
    const truncated = rows.length >= ROW_LIMIT ? ' Cloudflare’s row limit was reached, so this may be incomplete.' : '';
    const bucket = (sizeBase: MetricBase, countBase: MetricBase) => {
      const l = sizeBase.scopeLabel ? s.latest.get(sizeBase.scopeLabel) : undefined;
      if (!sizeBase.scopeLabel) return [sizeBase, countBase].map((m) => missing(m, 'not-configured', 'Bucket name not set.'));
      if (!l) return [sizeBase, countBase].map((m) => missing(m, 'unavailable', 'Cloudflare has no storage sample for this bucket yet.'));
      const at = new Date(l.at);
      return [measured(sizeBase, l.bytes, at), measured(countBase, l.objects, at)];
    };
    metrics.push(...bucket(b.imagesStorage, b.imagesObjects), ...bucket(b.stagingStorage, b.stagingObjects));
    metrics.push(measured(b.accountStorage, s.latestTotal, now, {
      note: `Every bucket in the Cloudflare account (preview buckets too); the free allowance is account-wide.${truncated}`,
    }));
    metrics.push(measured(b.storageMonth, s.gbMonths, now, {
      note: `R2 bills the average of each day’s peak storage (GB-month, GB = 10⁹ bytes here). Estimate so far this month. ${MONTH_NOTE}${truncated}`,
    }));
  } else {
    const message = safeMessage(storage.reason);
    metrics.push(...[b.imagesStorage, b.imagesObjects, b.stagingStorage, b.stagingObjects, b.accountStorage, b.storageMonth].map((m) => missing(m, 'error', message)));
  }

  if (operations.status === 'fulfilled') {
    const ops = summarizeOperations(operations.value);
    const extra = [
      ops.unknown > 0 ? `${ops.unknown.toLocaleString('en')} requests of unrecognised types are not counted.` : '',
      operations.value.length >= ROW_LIMIT ? 'Cloudflare’s row limit was reached, so this may be incomplete.' : '',
    ].filter(Boolean).join(' ');
    const note = `Whole account, all buckets. ${SAMPLED} ${MONTH_NOTE}${extra ? ` ${extra}` : ''}`;
    metrics.push(measured(b.classA, ops.classA, now, { note }), measured(b.classB, ops.classB, now, { note }));
  } else {
    const message = safeMessage(operations.reason);
    metrics.push(missing(b.classA, 'error', message), missing(b.classB, 'error', message));
  }
  return metrics;
}
