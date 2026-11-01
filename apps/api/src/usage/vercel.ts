import type { UsageMetric } from '@hexstory/shared';
import { missing, type MetricBase } from './common.js';

/**
 * Vercel: dashboard only. The documented billing API (`GET /v1/billing/charges`, FOCUS rows) needs
 * an access token, and Vercel tokens can't be read-only: a token that can read the team's billing
 * can also change its deployments and environment variables. That is too much power for a
 * dashboard, so nothing is fetched (docs/DEPLOYMENT.md, "Resource usage dashboard").
 */
const NOTE = 'Not read by the app: Vercel has no read-only token for usage data. See Usage in the Vercel dashboard.';

const metric = (id: string, label: string, unit: MetricBase['unit']): MetricBase => ({
  id, label, kind: 'period', scope: 'account', scopeLabel: null, unit,
  source: 'Vercel dashboard → Usage', sourceKind: 'provider', approximate: false,
  period: { start: null, resetsAt: null, label: 'Hobby has no billing cycle; usage counts over 30 days' },
});

export async function readVercel(): Promise<UsageMetric[]> {
  return [
    metric('vercel.transfer', 'Fast Data Transfer', 'bytes'),
    metric('vercel.invocations', 'Function invocations', 'count'),
    metric('vercel.cpu', 'Active CPU', 'cpu-hours'),
    metric('vercel.memory', 'Provisioned memory', 'gb-hours'),
  ].map((m) => missing(m, 'unavailable', NOTE));
}
