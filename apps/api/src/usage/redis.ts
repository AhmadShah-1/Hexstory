import type { UsageLimit, UsageMetric } from '@hexstory/shared';
import type { Coordinator } from '../coordination.js';
import { ProviderError, measured, missing, withTimeout, type MetricBase } from './common.js';
import { parseRedisInfo, toNumber } from './math.js';
import type { UsageSettings } from './settings.js';

const PROXY_NOTE = 'Redis Cloud answers INFO through its proxy, so values can differ slightly from its console.';

const base = {
  memory: {
    id: 'redis.memory', label: 'Memory', kind: 'capacity', scope: 'database', scopeLabel: null, unit: 'bytes',
    source: 'Redis INFO used_memory', sourceKind: 'application', approximate: true,
  },
  connections: {
    id: 'redis.connections', label: 'Connections', kind: 'capacity', scope: 'database', scopeLabel: null, unit: 'count',
    source: 'Redis INFO connected_clients', sourceKind: 'application', approximate: true,
  },
  ops: {
    id: 'redis.ops', label: 'Operations per second', kind: 'capacity', scope: 'database', scopeLabel: null, unit: 'ops-per-second',
    source: 'Redis INFO instantaneous_ops_per_sec', sourceKind: 'application', approximate: true,
  },
  evictions: {
    id: 'redis.evictions', label: 'Evicted keys', kind: 'period', scope: 'database', scopeLabel: null, unit: 'count',
    source: 'Redis INFO evicted_keys', sourceKind: 'application', approximate: false,
  },
} satisfies Record<string, MetricBase>;

/**
 * Redis: one `INFO` over the coordinator's existing command connection (no new connection, no key
 * scans). The Redis Cloud REST API isn't used: it needs account-owner keys and documents no
 * connection, throughput or eviction metrics for Essentials databases.
 */
export async function readRedis(deps: { coordinator: Coordinator; settings: UsageSettings; now: () => Date }): Promise<UsageMetric[]> {
  const { limits } = deps.settings.redis;
  // Memory limit: the configured plan size first. INFO maxmemory is a fallback only, since Redis
  // Cloud doesn't document what it reports there.
  const bases = {
    memory: { ...base.memory, limit: limits.memory },
    connections: { ...base.connections, limit: limits.connections },
    ops: { ...base.ops, limit: limits.opsPerSecond },
    evictions: base.evictions,
  };
  const all = (status: 'not-configured' | 'error', note: string) => Object.values(bases).map((b) => missing(b, status, note));

  let text: string | null;
  try {
    text = await withTimeout(deps.coordinator.info());
  } catch (err) {
    return all('error', err instanceof ProviderError ? err.message : 'Redis did not answer INFO (is it reachable?).');
  }
  if (text === null) return all('not-configured', 'REDIS_URL is not set: this process keeps chat, presence and rate limits in memory.');

  const info = parseRedisInfo(text);
  const at = deps.now();
  const num = (key: string) => toNumber(info.get(key));

  const maxmemory = num('maxmemory');
  const memoryLimit: UsageLimit | null =
    limits.memory ?? (maxmemory && maxmemory > 0 ? { value: maxmemory, unit: 'bytes', kind: 'hard', source: 'provider', label: 'Redis INFO maxmemory' } : null);
  const uptime = num('uptime_in_seconds');

  return [
    measured({ ...bases.memory, limit: memoryLimit }, num('used_memory'), at, {
      note: `Includes Redis’s own overhead; the plan’s limit counts the dataset. ${PROXY_NOTE}`,
    }),
    measured(bases.connections, num('connected_clients'), at, {
      note: `Each app instance holds 2 connections (commands and chat subscriber). ${PROXY_NOTE}`,
    }),
    measured(bases.ops, num('instantaneous_ops_per_sec'), at, { note: `A momentary sample, not an average. ${PROXY_NOTE}` }),
    measured(bases.evictions, num('evicted_keys'), at, {
      period: {
        start: uptime === null ? null : new Date(at.getTime() - uptime * 1000).toISOString(),
        resetsAt: null,
        label: 'Since Redis last restarted',
      },
      note: 'With the default no-eviction policy this stays 0, and writes fail instead when memory is full.',
    }),
  ];
}
