import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CORRECTION_PROBLEM_LABELS,
  LIMITS,
  TRUST,
  formatDateParts,
  type Correction,
  type Development,
  type PendingRevision,
  type Report,
  type UnreviewedStory,
} from '@hexstory/shared';
import { ApiError, errorMessage } from '../api/client';
import {
  keys,
  useModerateCorrection,
  useModerateDevelopment,
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

type Tab = 'pending' | 'new' | 'timelines' | 'corrections' | 'reports';
const TABS: Tab[] = ['pending', 'new', 'timelines', 'corrections', 'reports'];
const TAB_LABELS: Record<Tab, string> = {
  pending: 'Pending edits',
  new: 'New stories',
  timelines: 'Timelines',
  corrections: 'Corrections',
  reports: 'Reports',
};

/** Watchtower: the reviewer's queue of pending edits, new stories, held timeline additions, corrections and reports. */
export function Watchtower() {
  const session = useSession();
  const trust = session.data?.user?.trustLevel ?? 0;
  const isReviewer = trust >= TRUST.REVIEWER;
  const data = useWatchtower(isReviewer);
  // The tab lives in the URL, so Back returns to it after opening a story or version.
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'pending';
  const setTab = (t: Tab) => setParams(t === 'pending' ? {} : { tab: t }, { replace: true });
  const viewerId = session.data?.user?.id;

  if (session.isLoading) return <Panel title="Watchtower"><p className="muted pad">Loading…</p></Panel>;
  if (!isReviewer) {
    return (
      <Panel title="Watchtower">
        <p className="pad">The Watchtower is where trusted reviewers keep Hexstory healthy. You'll get access as you contribute.</p>
      </Panel>
    );
  }

  const counts: Record<Tab, number> = {
    pending: data.data?.pending.length ?? 0,
    new: data.data?.unreviewed.length ?? 0,
    timelines: data.data?.developments.length ?? 0,
    corrections: data.data?.corrections.length ?? 0,
    reports: data.data?.reports.length ?? 0,
  };
  return (
    <Panel
      title="Watchtower"
      subtitle={trust >= TRUST.MODERATOR ? <>Review queue · <Link to="/moderation">Moderation</Link></> : 'Review queue'}
      wide
    >
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
            {counts[t] > 0 && <span className="count">{counts[t]}</span>}
          </button>
        ))}
      </div>
      <div className="pad">
        {data.isLoading && <p className="muted">Loading…</p>}
        {data.error && !data.data && (
          <p className="error-text">
            {errorMessage(data.error)} <button className="link-button" onClick={() => data.refetch()}>Retry</button>
          </p>
        )}
        {tab === 'pending' && (
          <>
            <p className="queue-note">
              Edits wait here when the writer is new, the story is protected, or the change looks unusual (like
              removing most of the text or adding many links).
            </p>
            {data.data?.pending.length ? data.data.pending.map((p) => <PendingCard key={p.revision.id} item={p} viewerId={viewerId} />) : data.data && <Empty />}
          </>
        )}
        {tab === 'new' && (
          <>
            <p className="queue-note">Stories by newcomers stay private until a reviewer approves them.</p>
            {data.data?.unreviewed.length ? data.data.unreviewed.map((s) => <NewStoryCard key={s.story.id} item={s} viewerId={viewerId} />) : data.data && <Empty />}
          </>
        )}
        {tab === 'timelines' && (
          <>
            <p className="queue-note">Developments added to an event's timeline by newcomers, or to protected stories, wait here.</p>
            {data.data?.developments.length ? data.data.developments.map((d) => <DevelopmentCard key={d.id} item={d} viewerId={viewerId} />) : data.data && <Empty />}
          </>
        )}
        {tab === 'corrections' && (
          <>
            <p className="queue-note">
              Readers dispute a quoted statement and give evidence. Fix the story with a normal edit if they're right, then
              accept with a note; the note is public. Corrections to stories you started are for another reviewer.
            </p>
            {data.data?.corrections.length ? data.data.corrections.map((c) => <CorrectionCard key={c.id} item={c} viewerId={viewerId} isModerator={trust >= TRUST.MODERATOR} />) : data.data && <Empty />}
          </>
        )}
        {tab === 'reports' && (data.data?.reports.length ? data.data.reports.map((r) => <ReportCard key={r.id} report={r} />) : data.data && <Empty />)}
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
  if ((before.summary ?? '') !== (after.summary ?? '')) changes.push('summary');
  if (!same([...before.categories].sort(), [...after.categories].sort())) changes.push('categories');
  if (!same(before.location, after.location)) changes.push('place');
  if (!same(before.people, after.people)) changes.push('people');
  if (!same(before.links, after.links)) changes.push('connections');
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
      {c && (c.summary ?? '') !== (r.summary ?? '') && (
        <div className="small title-diff"><span className="muted">Summary:</span> <WordDiff before={c.summary ?? ''} after={r.summary ?? ''} /></div>
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

function DevelopmentCard({ item, viewerId }: { item: Development & { storyTitle: string }; viewerId: string | undefined }) {
  const moderate = useModerateDevelopment(item.storyId);
  const toast = useToast();
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/s/${item.storyId}`}><strong>{item.storyTitle}</strong></Link>
        <span className="muted small">
          by <Link to={`/u/${item.author.id}`}>{item.author.displayName}</Link> · {timeAgo(item.createdAt)}
        </span>
      </div>
      <p><strong>{formatDateParts(item.date)}</strong> · {item.title}{item.location?.placeName && <span className="muted"> · {item.location.placeName}</span>}</p>
      {item.body && <p className="excerpt">{item.body}</p>}
      <ul className="small">
        {item.sources.map((s, i) => <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="nofollow ugc noopener noreferrer">{s.title}</a> : s.title}</li>)}
      </ul>
      {item.author.id === viewerId ? (
        <p className="small muted">This is your own addition: another reviewer has to decide on it.</p>
      ) : (
        <div className="action-row">
          <button className="button button-primary" disabled={moderate.isPending} onClick={() => moderate.mutate({ id: item.id, action: 'accept' }, { onSuccess: () => toast('Added to the timeline') })}>
            Accept
          </button>
          <button className="button button-danger" disabled={moderate.isPending} onClick={() => moderate.mutate({ id: item.id, action: 'reject' }, { onSuccess: () => toast('Not accepted') })}>
            Reject
          </button>
        </div>
      )}
      {moderate.error && <p className="error-text">{errorMessage(moderate.error)}</p>}
    </div>
  );
}

function CorrectionCard({ item, viewerId, isModerator }: {
  item: Correction & { storyTitle: string; storyCreatedBy: string };
  viewerId: string | undefined;
  isModerator: boolean;
}) {
  const moderate = useModerateCorrection(item.storyId);
  const toast = useToast();
  const [note, setNote] = useState('');
  const decide = (decision: 'accepted' | 'rejected') =>
    moderate.mutate(
      { id: item.id, action: 'resolve', decision, note: note.trim() },
      { onSuccess: () => toast(decision === 'accepted' ? 'Correction accepted' : 'Correction not accepted') },
    );
  return (
    <div className="card">
      <div className="card-head">
        <Link to={`/s/${item.storyId}#corrections`}><strong>{item.storyTitle}</strong></Link>
        <span className="muted small">
          {CORRECTION_PROBLEM_LABELS[item.problem]} · by <Link to={`/u/${item.author.id}`}>{item.author.displayName}</Link> · {timeAgo(item.createdAt)}
        </span>
      </div>
      <blockquote className="correction-quote">{item.quote}</blockquote>
      <p className="small muted">{item.stillInStory ? 'Still in the current text.' : 'No longer in the current text (maybe already fixed).'}</p>
      <p>{item.proposal}</p>
      <ul className="small">
        {item.evidence.map((s, i) => <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="nofollow ugc noopener noreferrer">{s.title}</a> : s.title}</li>)}
      </ul>
      {item.author.id === viewerId ? (
        <p className="small muted">This is your own correction: another reviewer has to decide on it.</p>
      ) : item.storyCreatedBy === viewerId && !isModerator ? (
        <p className="small muted">You started this story: another reviewer has to decide on it.</p>
      ) : (
        <>
          <label className="field">
            <span>Public note explaining the decision</span>
            <textarea rows={2} maxLength={LIMITS.correctionNoteMax} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="action-row">
            <button className="button button-primary" disabled={!note.trim() || moderate.isPending} onClick={() => decide('accepted')}>Accept</button>
            <button className="button button-danger" disabled={!note.trim() || moderate.isPending} onClick={() => decide('rejected')}>Don't accept</button>
            <Link className="button" to={`/s/${item.storyId}/edit`}>Fix the story</Link>
          </div>
          <p className="small muted">To link the version that fixed it, decide from the story's Corrections section after editing.</p>
        </>
      )}
      {moderate.error && <p className="error-text">{errorMessage(moderate.error)}</p>}
    </div>
  );
}

function reportLink(report: Report): string | null {
  const { storyId, collectionId } = report.context;
  switch (report.targetType) {
    case 'story': return storyId ? `/s/${storyId}` : null;
    case 'revision': return `/v/${report.targetId}`;
    case 'development': return storyId ? `/s/${storyId}` : null;
    case 'correction': return storyId ? `/s/${storyId}#corrections` : null;
    case 'collection': return collectionId ? `/c/${collectionId}` : null;
    case 'user': return `/u/${report.targetId}`;
  }
}

function ReportCard({ report }: { report: Report }) {
  const resolve = useResolveReport();
  // Removing a version (or hiding a story) also closes the reports about it, so there's nothing left to resolve.
  const removeVersion = useSetRevisionRemoved(report.context.storyId ?? '');
  const hideStory = useSetStoryStatus(report.context.storyId ?? '');
  const toast = useToast();
  const link = reportLink(report);
  const removeDevelopment = useModerateDevelopment(report.context.storyId ?? '');
  const removeCorrection = useModerateCorrection(report.context.storyId ?? '');
  const busy = resolve.isPending || removeVersion.isPending || hideStory.isPending || removeDevelopment.isPending || removeCorrection.isPending;
  const error = resolve.error ?? removeVersion.error ?? hideStory.error ?? removeDevelopment.error ?? removeCorrection.error;
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
        {report.targetType === 'development' && (
          <ConfirmAction
            label="Remove development"
            explain="Only reviewers will see it on the timeline. This closes the report."
            busy={busy}
            onConfirm={(reason, done) => removeDevelopment.mutate({ id: report.targetId, action: 'remove', reason }, { onSuccess: () => { toast('Removed from the timeline'); done(); } })}
          />
        )}
        {report.targetType === 'correction' && (
          <ConfirmAction
            label="Remove correction"
            explain="For abuse only: only reviewers will see it. This closes the report."
            busy={busy}
            onConfirm={(reason, done) => removeCorrection.mutate({ id: report.targetId, action: 'remove', reason }, { onSuccess: () => { toast('Correction removed'); done(); } })}
          />
        )}
        {report.targetType === 'collection' && report.context.collectionId && (
          <Link className="button" to={`/c/${report.context.collectionId}`}>Open the collection</Link>
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
