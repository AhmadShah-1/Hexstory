import { Link, useSearchParams } from 'react-router';
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
import { ConfirmAction } from '../components/ConfirmAction';
import { Panel } from '../components/Panel';
import { useToast } from '../components/Toast';
import { WordDiff } from '../components/WordDiff';
import { timeAgo } from '../lib/format';

type Tab = 'pending' | 'new' | 'reports';

/** Watchtower: the reviewer's queue of pending edits, new stories and reports. */
export function Watchtower() {
  const session = useSession();
  const trust = session.data?.user?.trustLevel ?? 0;
  const isReviewer = trust >= TRUST.REVIEWER;
  const data = useWatchtower(isReviewer);
  // The tab lives in the URL, so Back returns to it after opening a story or version.
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = tabParam === 'new' || tabParam === 'reports' ? tabParam : 'pending';
  const setTab = (t: Tab) => setParams(t === 'pending' ? {} : { tab: t }, { replace: true });
  const viewerId = session.data?.user?.id;

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
            {data.data?.pending.length ? data.data.pending.map((p) => <PendingCard key={p.revision.id} item={p} viewerId={viewerId} />) : <Empty />}
          </>
        )}
        {tab === 'new' && (
          <>
            <p className="queue-note">Stories by newcomers stay private until a reviewer approves them.</p>
            {data.data?.unreviewed.length ? data.data.unreviewed.map((s) => <NewStoryCard key={s.story.id} item={s} viewerId={viewerId} />) : <Empty />}
          </>
        )}
        {tab === 'reports' && (data.data?.reports.length ? data.data.reports.map((r) => <ReportCard key={r.id} report={r} />) : <Empty />)}
      </div>
    </Panel>
  );
}

const Empty = () => <p className="muted">All clear.</p>;

/** What else a held edit changes besides the text, so a reviewer doesn't accept a change they can't see. */
function otherChanges(before: PendingRevision['currentRevision'], after: PendingRevision['revision']): string[] {
  if (!before) return [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changes: string[] = [];
  if (!same(before.sources, after.sources)) changes.push('sources');
  if (!same([before.start, before.end, before.isOngoing, before.isApprox], [after.start, after.end, after.isOngoing, after.isApprox])) changes.push('dates');
  if (!same([...before.cells].sort(), [...after.cells].sort())) changes.push('area on the map');
  if (before.thumbUrl !== after.thumbUrl) changes.push('photos');
  return changes;
}

function PendingCard({ item, viewerId }: { item: PendingRevision; viewerId: string | undefined }) {
  const { revision: r, currentRevision: c } = item;
  const review = useReviewRevision(r.storyId);
  const toast = useToast();
  const isNewStory = !r.parentRevisionId;
  const changes = otherChanges(c, r);
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/v/${r.id}`}><strong>{r.title}</strong></Link>
        <span className="muted small">
          by <Link to={`/u/${r.author.id}`}>{r.author.displayName}</Link> · {timeAgo(r.createdAt)}
        </span>
      </div>
      {c && c.title !== r.title && (
        <div className="small title-diff"><span className="muted">Title:</span> <WordDiff before={c.title} after={r.title} /></div>
      )}
      {isNewStory && <p className="small"><span className="chip chip-pending">New story</span> Accepting it publishes the story.</p>}
      {r.flags.map((f) => <span key={f} className="chip chip-flag">{f.replace('-', ' ')}</span>)}
      {changes.length > 0 && <p className="small">Also changes: {changes.join(', ')}. <Link to={`/v/${r.id}`}>See everything</Link></p>}
      {r.editSummary && <p className="small">“{r.editSummary}”</p>}
      <div className="diff-box">
        {c ? <WordDiff before={c.body} after={r.body} /> : <p>{r.body}</p>}
      </div>
      {r.author.id === viewerId ? (
        <p className="small muted">This is your own edit: another reviewer has to decide on it.</p>
      ) : (
        <div className="action-row">
          <button
            className="button button-primary"
            disabled={review.isPending}
            onClick={() => review.mutate({ revisionId: r.id, decision: 'accept' }, { onSuccess: () => toast(isNewStory ? 'Accepted and published' : 'Accepted') })}
          >
            Accept
          </button>
          <button
            className="button button-danger"
            disabled={review.isPending}
            onClick={() => review.mutate({ revisionId: r.id, decision: 'reject' }, { onSuccess: () => toast('Not accepted') })}
          >
            Reject
          </button>
        </div>
      )}
      {review.error && <p className="error-text">{errorMessage(review.error)}</p>}
    </div>
  );
}

function NewStoryCard({ item, viewerId }: { item: UnreviewedStory; viewerId: string | undefined }) {
  const { story, author } = item;
  const setStatus = useSetStoryStatus(story.id);
  const qc = useQueryClient();
  const toast = useToast();
  const onError = (err: Error) => {
    // The author changed it, or someone else decided meanwhile: reload so the reviewer sees the current state.
    if (err instanceof ApiError && (err.code === 'stale' || err.code === 'already-decided')) qc.invalidateQueries({ queryKey: keys.watchtower });
  };
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/s/${story.id}`}><strong>{story.title}</strong></Link>
        <span className="muted small">
          by <Link to={`/u/${author.id}`}>{author.displayName}</Link> · {timeAgo(item.createdAt)}
        </span>
      </div>
      {item.excerpt && <p className="excerpt">{item.excerpt}</p>}
      {author.id === viewerId ? (
        <p className="small muted">This is your own story: another reviewer has to approve it.</p>
      ) : (
        <div className="action-row">
          <button
            className="button button-primary"
            disabled={setStatus.isPending}
            onClick={() => setStatus.mutate({ status: 'active', revisionId: item.revisionId }, { onSuccess: () => toast('Approved. The story is now public.'), onError })}
          >
            Approve and publish
          </button>
          <ConfirmAction
            label="Reject"
            explain="The story stays private and its author sees it as not accepted. Only a moderator can bring it back."
            busy={setStatus.isPending}
            onConfirm={(reason, done) => setStatus.mutate({ status: 'hidden', reason }, { onSuccess: () => { toast('Not accepted'); done(); }, onError })}
          />
        </div>
      )}
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
  const hideStory = useSetStoryStatus(report.context.storyId ?? '');
  const toast = useToast();
  const link = reportLink(report);
  const busy = resolve.isPending || hide.isPending || removeVersion.isPending || hideStory.isPending;
  const error = resolve.error ?? hide.error ?? removeVersion.error ?? hideStory.error;
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
            onClick={() => hide.mutate(report.targetId, { onSuccess: () => toast('Message hidden') })}
          >
            Hide message
          </button>
        )}
        {report.targetType === 'story' && report.context.storyId && (
          <ConfirmAction
            label="Hide story"
            explain="Hidden stories are visible only to reviewers; only a moderator can bring one back. This closes the report."
            busy={busy}
            onConfirm={(reason, done) => hideStory.mutate({ status: 'hidden', reason }, { onSuccess: () => { toast('Story hidden'); done(); } })}
          />
        )}
        {report.targetType === 'revision' && (
          <ConfirmAction
            label="Remove version"
            explain="Only reviewers will be able to see this version, and it can't be restored. It can't be the story's current version. This closes the report."
            busy={busy}
            onConfirm={(reason, done) => removeVersion.mutate({ revisionId: report.targetId, removed: true, reason }, { onSuccess: () => { toast('Removed from the history'); done(); } })}
          />
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
