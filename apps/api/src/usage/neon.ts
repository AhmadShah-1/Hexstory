import type { UsageLimit, UsageMetric } from '@hexstory/shared';
import type { Sql } from '../db.js';
import { fetchJson, measured, missing, safeMessage, withTimeout, type FetchFn, type MetricBase } from './common.js';
import { toNumber } from './math.js';
import type { UsageSettings } from './settings.js';

export const NEON_API = 'https://console.neon.tech/api/v2';

const API_NOTE = 'Neon updates usage about every 15 minutes; it can take up to an hour to appear.';

const base = {
  databaseSize: {
    id: 'neon.databaseSize', label: 'Database size', kind: 'capacity', scope: 'database', scopeLabel: null, unit: 'bytes',
    source: 'Postgres pg_database_size()', sourceKind: 'application', approximate: false,
  },
  projectStorage: {
    id: 'neon.projectStorage', label: 'Project storage (all branches)', kind: 'capacity', scope: 'project', scopeLabel: null, unit: 'bytes',
    source: 'Neon API: sum of branch logical_size', sourceKind: 'provider', approximate: true,
  },
  compute: {
    id: 'neon.compute', label: 'Compute', kind: 'period', scope: 'project', scopeLabel: null, unit: 'cu-hours',
    source: 'Neon API: project compute_time_seconds ÷ 3600', sourceKind: 'provider', approximate: true,
  },
  transfer: {
    id: 'neon.transfer', label: 'Network transfer', kind: 'period', scope: 'project', scopeLabel: null, unit: 'bytes',
    source: 'Neon API: project data_transfer_bytes', sourceKind: 'provider', approximate: true,
  },
} satisfies Record<string, MetricBase>;

interface NeonProject {
  compute_time_seconds?: unknown;
  data_transfer_bytes?: unknown;
  consumption_period_start?: unknown;
  consumption_period_end?: unknown;
  settings?: { quota?: { compute_time_seconds?: unknown; data_transfer_bytes?: unknown } };
}

/** A customer-set project quota (Neon suspends compute when it is reached). Provider-reported. */
function quota(value: unknown, scale: number, unit: UsageLimit['unit'], field: string): UsageLimit | null {
  const n = toNumber(value);
  return n && n > 0 ? { value: n / scale, unit, kind: 'hard', source: 'provider', label: `Neon project quota (${field})` } : null;
}

const isoOrNull = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * Neon: the database's own size (always, from our connection) and, with the optional monitoring
 * key, project storage, compute and transfer from Neon's API (available on the Free plan through
 * the project and branch endpoints; the consumption endpoints need a paid plan).
 */
export async function readNeon(deps: { sql: Sql; settings: UsageSettings; fetch: FetchFn; now: () => Date }): Promise<UsageMetric[]> {
  const { sql, settings, now } = deps;
  const { apiKey, projectId, limits } = settings.neon;

  const sizeReading = (async (): Promise<UsageMetric> => {
    try {
      const [row] = await withTimeout(sql<{ name: string; size: number }[]>`
        SELECT current_database() AS name, pg_database_size(current_database())::float8 AS size`);
      return measured(base.databaseSize, toNumber(row?.size), now(), {
        scopeLabel: row?.name ?? null,
        note: 'This database as Postgres counts it. Neon’s storage limit counts every branch of the project, so it isn’t compared here.',
      });
    } catch (err) {
      return missing(base.databaseSize, 'error', safeMessage(err));
    }
  })();

  if (!apiKey || !projectId) {
    const note = 'Optional: set USAGE_NEON_API_KEY and USAGE_NEON_PROJECT_ID (docs/DEPLOYMENT.md, "Resource usage dashboard").';
    return [
      await sizeReading,
      missing({ ...base.projectStorage, limit: limits.storage }, 'not-configured', note),
      missing({ ...base.compute, limit: limits.compute }, 'not-configured', note),
      missing({ ...base.transfer, limit: limits.transfer }, 'not-configured', note),
    ];
  }

  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
  const projectUrl = `${NEON_API}/projects/${encodeURIComponent(projectId)}`;
  const [project, branches] = await Promise.allSettled([
    fetchJson(deps.fetch, projectUrl, { headers }) as Promise<{ project?: NeonProject }>,
    fetchJson(deps.fetch, `${projectUrl}/branches`, { headers }) as Promise<{ branches?: { logical_size?: unknown }[] }>,
  ]);
  const at = now();
  const metrics = [await sizeReading];

  if (branches.status === 'fulfilled' && Array.isArray(branches.value?.branches)) {
    const sizes = branches.value.branches.map((b) => toNumber(b?.logical_size));
    const total = sizes.length && sizes.every((s) => s !== null) ? sizes.reduce<number>((a, s) => a + s!, 0) : null;
    metrics.push(measured({ ...base.projectStorage, limit: limits.storage }, total, at, {
      note: `${sizes.length} ${sizes.length === 1 ? 'branch' : 'branches'}. Neon’s Free storage limit is based on this logical size. ${API_NOTE}`,
    }));
  } else {
    const err = branches.status === 'rejected' ? branches.reason : null;
    metrics.push(missing({ ...base.projectStorage, limit: limits.storage }, 'error', err ? safeMessage(err) : 'Unexpected response from Neon.'));
  }

  const p = project.status === 'fulfilled' ? project.value?.project : undefined;
  if (p && typeof p === 'object') {
    const period = {
      start: isoOrNull(p.consumption_period_start),
      resetsAt: isoOrNull(p.consumption_period_end),
      label: 'Neon consumption period',
    };
    const seconds = toNumber(p.compute_time_seconds);
    metrics.push(measured(
      { ...base.compute, limit: quota(p.settings?.quota?.compute_time_seconds, 3600, 'cu-hours', 'compute_time_seconds') ?? limits.compute, period },
      seconds === null ? null : seconds / 3600,
      at,
      { note: API_NOTE },
    ));
    metrics.push(measured(
      { ...base.transfer, limit: quota(p.settings?.quota?.data_transfer_bytes, 1, 'bytes', 'data_transfer_bytes') ?? limits.transfer, period },
      toNumber(p.data_transfer_bytes),
      at,
      { note: `Public and private transfer combined (the Free allowance counts public transfer). ${API_NOTE}` },
    ));
  } else {
    const message = project.status === 'rejected' ? safeMessage(project.reason) : 'Unexpected response from Neon.';
    metrics.push(missing({ ...base.compute, limit: limits.compute }, 'error', message));
    metrics.push(missing({ ...base.transfer, limit: limits.transfer }, 'error', message));
  }
  return metrics;
}
