import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TRUST } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useRestoreRevision, useReviewRevision, useRevision, useSession, useSetRevisionRemoved, useStory } from '../api/queries';
import { Panel } from '../components/Panel';
import { ReportDialog } from '../components/ReportDialog';
import { StoryContent } from '../components/StoryContent';
import { useToast } from '../components/Toast';
import { WordDiff } from '../components/WordDiff';
import { shortDate } from '../lib/format';
import { useMapState } from '../map/MapContext';
import { LoadFailed, NotFound } from './NotFound';

export function RevisionView() {
  const { revisionId = '' } = useParams();
  const revision = useRevision(revisionId);
  const parent = useRevision(revision.data?.parentRevisionId);
  const story = useStory(revision.data?.storyId);
  const session = useSession();
  const [showChanges, setShowChanges] = useState(true);
  const [reporting, setReporting] = useState(false);
  const { setStoryCells } = useMapState();

  const cells = revision.data?.cells;
  useEffect(() => {
    if (!cells) return;
    setStoryCells(cells);
    return () => setStoryCells([]);
  }, [cells, setStoryCells]);

  if (revision.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  if (!revision.data) {
    return revision.error ? <LoadFailed error={revision.error} what="version" retry={() => revision.refetch()} /> : <NotFound what="version" />;
  }
  const r = revision.data;
  const isCurrent = story.data?.revision.id === r.id;
  const viewer = session.data?.user;

  return (
    <Panel
      title={`Version from ${shortDate(r.createdAt)}`}
      subtitle={
        <>
          by <Link to={`/u/${r.author.id}`}>{r.author.displayName}</Link>
          {r.editSummary && ` · “${r.editSummary}”`}
        </>
      }
      back={{ label: 'All versions', to: `/s/${r.storyId}/versions` }}
    >
      <div className="pad">
        {r.removed && <p className="notice">This version was removed from the history.</p>}
        {story.data?.can.review && (
          <ReviewBar
            storyId={r.storyId}
            revisionId={r.id}
            status={r.status}
            isCurrent={isCurrent}
            isFirst={!r.parentRevisionId}
            removed={r.removed}
            isAuthor={viewer?.id === r.author.id}
            viewerLevel={viewer?.trustLevel ?? 0}
            protectionLevel={story.data.protectionLevel}
            storyStatus={story.data.status}
            currentRevisionId={story.data.revision.id}
          />
        )}
        {parent.data && (
          <label className="toggle">
            <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
            Highlight changes from the previous version
          </label>
        )}
        {showChanges && parent.data ? (
          <div className="story">
            <h2 className="story-title"><WordDiff before={parent.data.title} after={r.title} /></h2>
            <WordDiff before={parent.data.body} after={r.body} />
            <h3 className="section-label">Sources</h3>
            <WordDiff
              before={parent.data.sources.map((s) => `${s.title} ${s.url ?? ''}`).join('\n')}
              after={r.sources.map((s) => `${s.title} ${s.url ?? ''}`).join('\n')}
            />
          </div>
        ) : (
          <StoryContent revision={r} cellCount={story.data?.cellCount ?? 1} />
        )}
        {viewer && (
          <div className="action-row">
            <button className="button button-quiet" onClick={() => setReporting(true)}>Report this version</button>
          </div>
        )}
      </div>
      {reporting && <ReportDialog open onClose={() => setReporting(false)} targetType="revision" targetId={r.id} />}
    </Panel>
  );
}

/**
 * Reviewer actions on one version. Nobody reviews or restores their own work; removing a version
 * (e.g. it exposed someone's personal details) hides it from the history for good, unless a moderator puts it back.
 */
function ReviewBar({ storyId, revisionId, status, isCurrent, isFirst, removed, isAuthor, viewerLevel, protectionLevel, storyStatus, currentRevisionId }: {
  storyId: string;
  revisionId: string;
  status: string;
  isCurrent: boolean;
  isFirst: boolean;
  removed: boolean;
  isAuthor: boolean;
  viewerLevel: number;
  protectionLevel: number;
  storyStatus: string;
  currentRevisionId: string;
}) {
  const review = useReviewRevision(storyId);
  const restore = useRestoreRevision(storyId);
  const setRemoved = useSetRevisionRemoved(storyId);
  const navigate = useNavigate();
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const error = review.error ?? restore.error ?? setRemoved.error;
  const busy = review.isPending || restore.isPending || setRemoved.isPending;
  const isModerator = viewerLevel >= TRUST.MODERATOR;
  // Protection decides who can put a change live: editing, accepting someone's edit, or restoring.
  const mayPutLive = viewerLevel >= Math.max(TRUST.MEMBER, protectionLevel);

  const canDecide = status === 'pending' && !isAuthor && !removed && storyStatus !== 'hidden';
  const canRestore = status === 'accepted' && !isCurrent && !isAuthor && !removed && mayPutLive && storyStatus !== 'unreviewed';
  const canRemove = !isCurrent && !removed;
  const canPutBack = removed && isModerator;
  if (!canDecide && !canRestore && !canRemove && !canPutBack) return null;

  const remove = () =>
    setRemoved.mutate(
      { revisionId, removed: true, reason: reason.trim() || undefined },
      { onSuccess: () => { toast('Removed from the history'); setRemoving(false); setReason(''); } },
    );

  return (
    <div className="review-bar">
      {canDecide && (
        <>
          <span>
            {isFirst && storyStatus === 'unreviewed'
              ? 'This new story is waiting for review. Accepting it publishes the story.'
              : 'This edit is waiting for review.'}
          </span>
          {mayPutLive ? (
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => review.mutate({ revisionId, decision: 'accept' }, {
                onSuccess: () => { toast(isFirst && storyStatus === 'unreviewed' ? 'Accepted and published' : 'Accepted'); navigate(`/s/${storyId}`); },
              })}
            >
              Accept
            </button>
          ) : (
            <span className="muted small">This story is protected: only a moderator can accept edits to it.</span>
          )}
          <button className="button button-danger" disabled={busy} onClick={() => review.mutate({ revisionId, decision: 'reject' }, { onSuccess: () => toast('Not accepted') })}>
            Reject
          </button>
        </>
      )}
      {canRestore && (
        <button
          className="button"
          disabled={busy}
          onClick={() => restore.mutate({ revisionId, baseRevisionId: currentRevisionId }, { onSuccess: () => { toast('Restored'); navigate(`/s/${storyId}`); } })}
        >
          Restore this version
        </button>
      )}
      {canRemove && !removing && (
        <button className="button button-danger" disabled={busy} onClick={() => setRemoving(true)}>Remove from history</button>
      )}
      {canPutBack && (
        <button className="button" disabled={setRemoved.isPending} onClick={() => setRemoved.mutate({ revisionId, removed: false }, { onSuccess: () => toast('Put back in the history') })}>
          Put it back
        </button>
      )}
      {removing && (
        <div className="remove-confirm">
          <p className="small">
            Only reviewers will be able to see this version, and it can't be restored. Use this for versions that
            expose personal details or are abusive.
          </p>
          <input placeholder="Reason (optional)" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <button className="button button-danger" disabled={setRemoved.isPending} onClick={remove}>Remove</button>
            <button className="button" onClick={() => setRemoving(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="error-text">{errorMessage(error)}</p>}
    </div>
  );
}
