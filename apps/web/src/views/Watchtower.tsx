import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { TRUST, type PendingRevision, type Report, type UnreviewedStory } from '@hexstory/shared';
import { ApiError, errorMessage } from '../api/client';
import {
  keys,
  useHideMessage,
  useResolveReport,
  useReviewRevision,
  useSession,
  useSetRevisionRemoved,
  useSetStoryStatus,
  useWatchtower,
} from '../api/queries';
import { Panel } from '../components/Panel';
import { WordDiff } from '../components/WordDiff';
import { timeAgo } from '../lib/format';

type Tab = 'pending' | 'new' | 'reports';

/** Watchtower: the reviewer's queue of pending edits, new stories and reports. */
export function Watchtower() {
  const session = useSession();
  const trust = session.data?.user?.trustLevel ?? 0;
  const isReviewer = trust >= TRUST.REVIEWER;
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
    <Panel
      title="Watchtower"
      subtitle={trust >= TRUST.MODERATOR ? <>Review queue · <Link to="/moderation">Moderation</Link></> : 'Review queue'}
      wide
    >
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
        {tab === 'pending' && (
          <>
            <p className="queue-note">
              Edits wait here when the writer is new, the story is protected, or the change looks unusual (like
              removing most of the text or adding many links).
            </p>
            {data.data?.pending.length ? data.data.pending.map((p) => <PendingCard key={p.revision.id} item={p} />) : <Empty />}
          </>
        )}
        {tab === 'new' && (
          <>
            <p className="queue-note">Stories by newcomers stay private until a reviewer approves them.</p>
            {data.data?.unreviewed.length ? data.data.unreviewed.map((s) => <NewStoryCard key={s.story.id} item={s} />) : <Empty />}
          </>
        )}
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
        <span className="muted small">
          by <Link to={`/u/${r.author.id}`}>{r.author.displayName}</Link> · {timeAgo(r.createdAt)}
        </span>
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

function NewStoryCard({ item }: { item: UnreviewedStory }) {
  const { story, author } = item;
  const setStatus = useSetStoryStatus(story.id);
  const qc = useQueryClient();
  const decide = (status: 'active' | 'hidden') =>
    setStatus.mutate(status === 'active' ? { status, revisionId: item.revisionId } : { status }, {
      // The author changed it meanwhile: reload the queue so the reviewer sees (and approves) the new text.
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'stale') qc.invalidateQueries({ queryKey: keys.watchtower });
      },
    });
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/s/${story.id}`}><strong>{story.title}</strong></Link>
        <span className="muted small">
          by <Link to={`/u/${author.id}`}>{author.displayName}</Link> · {timeAgo(item.createdAt)}
        </span>
      </div>
      {item.excerpt && <p className="excerpt">{item.excerpt}</p>}
      <div className="action-row">
        <button className="button button-primary" disabled={setStatus.isPending} onClick={() => decide('active')}>Approve and publish</button>
        <button className="button button-danger" disabled={setStatus.isPending} onClick={() => decide('hidden')}>Reject</button>
      </div>
      {setStatus.error && <p className="error-text">{errorMessage(setStatus.error)}</p>}
    </div>
  );
}

function reportLink(report: Report): string | null {
  const { storyId, cell } = report.context;
  switch (report.targetType) {
    case 'story': return storyId ? `/s/${storyId}` : null;
    case 'revision': return `/v/${report.targetId}`;
    case 'comment': return cell ? `/h/${cell}?tab=square` : null;
    case 'user': return `/u/${report.targetId}`;
  }
}

function ReportCard({ report }: { report: Report }) {
  const resolve = useResolveReport();
  const hide = useHideMessage();
  // Hiding a message or removing a version also closes the reports about it, so there's nothing left to resolve.
  const removeVersion = useSetRevisionRemoved(report.context.storyId ?? '');
  const link = reportLink(report);
  const busy = resolve.isPending || hide.isPending || removeVersion.isPending;
  const error = resolve.error ?? hide.error ?? removeVersion.error;
  return (
    <div className="card">
      <div className="card-head">
        <strong>{report.reason.replace('-', ' ')}</strong>
        <span className="muted small">
          {report.targetType} · reported by <Link to={`/u/${report.reporter.id}`}>{report.reporter.displayName}</Link> · {timeAgo(report.createdAt)}
        </span>
      </div>
      <p>{link ? <Link to={link}>{report.context.label}</Link> : report.context.label}</p>
      {report.details && <p className="small muted">“{report.details}”</p>}
      <div className="action-row">
        {report.targetType === 'comment' && (
          <button
            className="button button-danger"
            disabled={busy}
            onClick={() => hide.mutate(report.targetId)}
          >
            Hide message
          </button>
        )}
        {report.targetType === 'revision' && (
          <button
            className="button button-danger"
            disabled={busy}
            onClick={() => removeVersion.mutate({ revisionId: report.targetId, removed: true })}
          >
            Remove version
          </button>
        )}
        {report.targetType === 'user' && (
          <Link className="button" to={`/u/${report.targetId}`}>Open their page</Link>
        )}
        <button className="button" disabled={busy} onClick={() => resolve.mutate({ id: report.id, resolution: 'actioned' })}>Handled</button>
        <button className="button button-quiet" disabled={busy} onClick={() => resolve.mutate({ id: report.id, resolution: 'dismissed' })}>Dismiss</button>
      </div>
      {report.targetType === 'user' && <p className="small muted">Ban requests and bans happen on their page.</p>}
      {error && <p className="error-text">{errorMessage(error)}</p>}
    </div>
  );
}
