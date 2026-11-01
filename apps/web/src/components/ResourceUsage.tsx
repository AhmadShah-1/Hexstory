import type { ProviderUsage, UsageMetric, UsageScope, UsageUnit } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useRefreshUsage, useUsage } from '../api/queries';
import { shortDate, timeAgo } from '../lib/format';

/**
 * Moderators: hosting resource usage per provider. "Now" (capacity in use) and "This period"
 * (cumulative use that resets) are kept apart. A bar and percentage appear only when the server
 * could compare the value with a known limit in the same unit; missing data is never shown as 0.
 */
export function ResourceUsage() {
  const usage = useUsage();
  const refresh = useRefreshUsage();
  const report = usage.data;

  return (
    <div className="usage">
      <div className="usage-toolbar">
        <p className="small muted">
          {report
            ? `Readings are reused for ${Math.round(report.cacheSeconds / 60)} min. Shown ${timeAgo(report.generatedAt)}.`
            : 'Hosting usage from Neon, Redis Cloud, Cloudflare R2 and Vercel.'}
        </p>
        <button className="button" disabled={refresh.isPending || usage.isLoading} onClick={() => refresh.mutate()}>
          {refresh.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {refresh.error && <p className="error-text usage-refresh-error" role="status">{errorMessage(refresh.error)}</p>}
      {usage.isLoading && <p className="muted">Loading…</p>}
      {usage.error && <p className="error-text">{errorMessage(usage.error)}</p>}
      {report && report.configProblems.length > 0 && (
        <div className="usage-problems small" role="note">
          <strong>Some settings were ignored:</strong>
          <ul>{report.configProblems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {report?.providers.map((p) => <ProviderCard key={p.id} provider={p} />)}
      {report && (
        <p className="small muted usage-legend">
          <strong>Hard limit</strong>: the service stops, throttles or pauses there. <strong>Included</strong>: an allowance;
          use beyond it is billed. Bars turn amber at {report.thresholds.warningPercent}% and red at {report.thresholds.criticalPercent}%.
          “Measured by the app” numbers come from our own queries; “provider data” comes from the provider’s API.
        </p>
      )}
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderUsage }) {
  const levels = provider.metrics.map((m) => m.comparison?.level);
  const worst = levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : null;
  const now = provider.metrics.filter((m) => m.kind === 'capacity');
  const period = provider.metrics.filter((m) => m.kind === 'period');
  return (
    <section className="card usage-card" aria-labelledby={`usage-${provider.id}`}>
      <header className="usage-card-head">
        <h3 id={`usage-${provider.id}`}>
          {provider.name}
          {worst && <span className={`chip ${worst === 'critical' ? 'chip-rejected' : 'chip-pending'}`}>{worst === 'critical' ? 'Near a limit' : 'Getting close'}</span>}
        </h3>
        <a href={provider.dashboardUrl} target="_blank" rel="noopener noreferrer" className="small">
          {provider.name} dashboard ↗
        </a>
      </header>
      {provider.metrics.length === 0 && <p className="small muted">No readings yet.</p>}
      <MetricGroup title="Now" hint="in use at the moment" metrics={now} />
      <MetricGroup title="This period" hint="adds up until it resets" metrics={period} />
      {provider.checkedAt && <p className="small muted usage-checked">Checked {timeAgo(provider.checkedAt)}</p>}
    </section>
  );
}

function MetricGroup({ title, hint, metrics }: { title: string; hint: string; metrics: UsageMetric[] }) {
  if (!metrics.length) return null;
  // Several metrics missing for the same reason (e.g. no credential) read better as one line.
  const first = metrics[0]!;
  if (metrics.every((m) => m.status !== 'ok' && m.status === first.status && m.note === first.note)) {
    return (
      <div className="usage-group">
        <h4>{title} <span className="muted">· {hint}</span></h4>
        <div className="usage-missing">
          <StatusChip metric={first} />
          <span className="small">{metrics.map((m) => m.label).join(', ')}</span>
          {first.note && <p className="small muted">{first.note}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="usage-group">
      <h4>{title} <span className="muted">· {hint}</span></h4>
      <ul className="usage-list">{metrics.map((m) => <MetricRow key={m.id} metric={m} />)}</ul>
    </div>
  );
}

const SCOPES: Record<UsageScope, string> = {
  database: 'this database',
  project: 'whole project',
  bucket: 'bucket',
  account: 'whole account',
  instance: 'this instance',
};

function MetricRow({ metric: m }: { metric: UsageMetric }) {
  const c = m.comparison;
  const scope = m.scopeLabel ? `${SCOPES[m.scope]} ${m.scopeLabel}` : SCOPES[m.scope];
  return (
    <li className="usage-metric">
      <div className="usage-metric-top">
        <span className="usage-label">{m.label}</span>
        {m.status === 'ok' && m.value !== null ? <span className="usage-value">{formatValue(m.value, m.unit)}</span> : <StatusChip metric={m} />}
      </div>
      {c && (
        <div className={`usage-bar usage-${c.level}`} aria-hidden="true">
          <div style={{ width: `${Math.min(100, Math.max(0, c.percent))}%` }} />
        </div>
      )}
      {m.limit && (
        <p className="small usage-limit">
          {c ? (
            <>
              <strong>{formatPercent(c.percent)}</strong> of {formatValue(m.limit.value, m.limit.unit)} ·{' '}
              {c.remaining >= 0 ? `${formatValue(c.remaining, m.unit)} left` : `${formatValue(-c.remaining, m.unit)} over`}
            </>
          ) : (
            <>Limit {formatValue(m.limit.value, m.limit.unit)}</>
          )}{' '}
          <span
            className="chip chip-quiet usage-kind"
            title={m.limit.kind === 'hard' ? 'The service stops, throttles or pauses at this limit' : 'An allowance: use beyond it is billed'}
          >
            {m.limit.kind === 'hard' ? 'hard limit' : 'included'}
          </span>
          <span className="muted"> · {m.limit.source === 'provider' ? 'reported by' : 'set in'} {m.limit.label}</span>
        </p>
      )}
      {m.stale && m.measuredAt && <span className="chip chip-pending usage-stale">Stale (updated {timeAgo(m.measuredAt)})</span>}
      <p className="small muted usage-meta">
        {scope}
        {m.period && ` · ${periodText(m.period)}`}
        {' · '}
        {m.sourceKind === 'application' ? 'measured by the app' : 'provider data'}
        {m.approximate && ', approximate'}
        {m.measuredAt && !m.stale && ` · ${timeAgo(m.measuredAt)}`}
      </p>
      <p className="small muted usage-source">{m.source}</p>
      {m.note && <p className="small muted">{m.note}</p>}
    </li>
  );
}

function StatusChip({ metric: m }: { metric: UsageMetric }) {
  switch (m.status) {
    case 'not-configured':
      return <span className="chip chip-quiet usage-status">Not configured</span>;
    case 'unavailable':
      return <span className="chip chip-quiet usage-status">Unavailable</span>;
    case 'error':
      return <span className="chip chip-rejected usage-status">Couldn’t read</span>;
    default:
      return <span className="chip chip-quiet usage-status">No value</span>;
  }
}

function periodText(p: NonNullable<UsageMetric['period']>): string {
  const parts = [p.label];
  if (p.start) parts.push(`since ${shortDate(p.start)}`);
  if (p.resetsAt) parts.push(`resets ${shortDate(p.resetsAt)}`);
  return parts.join(', ');
}

const formatPercent = (pct: number) => (pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`);

const number = (n: number, digits = 2) => n.toLocaleString(undefined, { maximumFractionDigits: digits });

/** Decimal units (1 GB = 10⁹ bytes), the same as the configured limits. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${number(value, i === 0 ? 0 : value < 10 ? 2 : 1)} ${units[i]}`;
}

function formatValue(value: number, unit: UsageUnit): string {
  switch (unit) {
    case 'bytes':
      return formatBytes(value);
    case 'count':
      return number(value, 0);
    case 'ops-per-second':
      return `${number(value, 1)} ops/s`;
    case 'cu-hours':
      return `${number(value)} CU-hours`;
    case 'cpu-hours':
      return `${number(value)} CPU-hours`;
    case 'gb-hours':
      return `${number(value)} GB-hours`;
    case 'gb-months':
      return `${number(value, 3)} GB-months`;
  }
}
