import { useState } from 'react';
import { Link } from 'react-router';
import { TRUST, type PendingRevision, type Report } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useHideMessage, useResolveReport, useReviewRevision, useSession, useWatchtower } from '../api/queries';
import { Panel } from '../components/Panel';
import { StoryRow } from '../components/StoryRow';
import { WordDiff } from '../components/WordDiff';
import { timeAgo } from '../lib/format';

type Tab = 'pending' | 'new' | 'reports';

/** Watchtower: the reviewer's queue of pending edits, new stories and reports. */
export function Watchtower() {
  const session = useSession();
  const isReviewer = (session.data?.user?.trustLevel ?? 0) >= TRUST.REVIEWER;
  const data = useWatchtower(isReviewer);
  const [tab, setTab] = useState<Tab>('pending');

  if (!isReviewer) {
    return (
      <Panel title="Watchtower">
        <p className="pad">The Watchtower is where trusted reviewers keep Hexstory healthy. You'll get access as you contribute.</p>
      </Panel>
    );
  }

  const counts = { pending: data.data?.pending.length ?? 0, new: data.data?.unreviewed.length ?? 0, reports: data.data?.reports.length ?? 0 };
  return (
    <Panel title="Watchtower" subtitle="Review queue" wide>
      <div className="tabs" role="tablist">
        {(['pending', 'new', 'reports'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'pending' ? 'Pending edits' : t === 'new' ? 'New stories' : 'Reports'}
            {counts[t] > 0 && <span className="count">{counts[t]}</span>}
          </button>
        ))}
      </div>
      <div className="pad">
        {data.isLoading && <p className="muted">Loading…</p>}
        {tab === 'pending' && (data.data?.pending.length ? data.data.pending.map((p) => <PendingCard key={p.revision.id} item={p} />) : <Empty />)}
        {tab === 'new' && (data.data?.unreviewed.length ? data.data.unreviewed.map((s) => <StoryRow key={s.id} story={s} />) : <Empty />)}
        {tab === 'reports' && (data.data?.reports.length ? data.data.reports.map((r) => <ReportCard key={r.id} report={r} />) : <Empty />)}
      </div>
    </Panel>
  );
}

const Empty = () => <p className="muted">All clear.</p>;

function PendingCard({ item }: { item: PendingRevision }) {
  const { revision: r, currentRevision: c } = item;
  const review = useReviewRevision(r.storyId);
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/v/${r.id}`}><strong>{r.title}</strong></Link>
        <span className="muted small">by {r.author.displayName} · {timeAgo(r.createdAt)}</span>
      </div>
      {r.flags.map((f) => <span key={f} className="chip chip-flag">{f.replace('-', ' ')}</span>)}
      {r.editSummary && <p className="small">“{r.editSummary}”</p>}
      <div className="diff-box">
        {c ? <WordDiff before={c.body} after={r.body} /> : <p>{r.body}</p>}
      </div>
      <div className="action-row">
        <button className="button button-primary" disabled={review.isPending} onClick={() => review.mutate({ revisionId: r.id, decision: 'accept' })}>Accept</button>
        <button className="button button-danger" disabled={review.isPending} onClick={() => review.mutate({ revisionId: r.id, decision: 'reject' })}>Reject</button>
      </div>
      {review.error && <p className="error-text">{errorMessage(review.error)}</p>}
    </div>
  );
}

function ReportCard({ report }: { report: Report }) {
  const resolve = useResolveReport();
  const hide = useHideMessage();
  const link = report.context.storyId ? `/s/${report.context.storyId}` : report.context.cell ? `/h/${report.context.cell}?tab=square` : null;
  return (
    <div className="card">
      <div className="card-head">
        <strong>{report.reason.replace('-', ' ')}</strong>
        <span className="muted small">{report.targetType} · reported by {report.reporter.displayName} · {timeAgo(report.createdAt)}</span>
      </div>
      <p>{link ? <Link to={link}>{report.context.label}</Link> : report.context.label}</p>
      {report.details && <p className="small muted">“{report.details}”</p>}
      <div className="action-row">
        {report.targetType === 'comment' && (
          <button
            className="button button-danger"
            onClick={() => hide.mutate(report.targetId, { onSuccess: () => resolve.mutate({ id: report.id, resolution: 'actioned' }) })}
          >
            Hide message
          </button>
        )}
        <button className="button" onClick={() => resolve.mutate({ id: report.id, resolution: 'actioned' })}>Handled</button>
        <button className="button button-quiet" onClick={() => resolve.mutate({ id: report.id, resolution: 'dismissed' })}>Dismiss</button>
      </div>
      {(resolve.error ?? hide.error) && <p className="error-text">{errorMessage(resolve.error ?? hide.error)}</p>}
    </div>
  );
}
