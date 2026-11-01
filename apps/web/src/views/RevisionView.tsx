import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { useRestoreRevision, useReviewRevision, useRevision, useSession, useStory } from '../api/queries';
import { Panel } from '../components/Panel';
import { StoryContent } from '../components/StoryContent';
import { useToast } from '../components/Toast';
import { WordDiff } from '../components/WordDiff';
import { shortDate } from '../lib/format';
import { useMapState } from '../map/MapContext';
import { NotFound } from './NotFound';

export function RevisionView() {
  const { revisionId = '' } = useParams();
  const revision = useRevision(revisionId);
  const parent = useRevision(revision.data?.parentRevisionId);
  const story = useStory(revision.data?.storyId);
  const session = useSession();
  const [showChanges, setShowChanges] = useState(true);
  const { setStoryCells } = useMapState();

  const cells = revision.data?.cells;
  useEffect(() => {
    if (!cells) return;
    setStoryCells(cells);
    return () => setStoryCells([]);
  }, [cells, setStoryCells]);

  if (revision.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  if (!revision.data) return <NotFound what="version" />;
  const r = revision.data;
  const isCurrent = story.data?.revision.id === r.id;
  const canReview = !!story.data?.can.review && session.data?.user?.id !== r.author.id;

  return (
    <Panel
      title={`Version from ${shortDate(r.createdAt)}`}
      subtitle={`by ${r.author.displayName}${r.editSummary ? ` · “${r.editSummary}”` : ''}`}
      back={{ label: 'All versions', to: `/s/${r.storyId}/versions` }}
    >
      <div className="pad">
        {canReview && (
          <ReviewBar storyId={r.storyId} revisionId={r.id} status={r.status} isCurrent={isCurrent} />
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
      </div>
    </Panel>
  );
}

function ReviewBar({ storyId, revisionId, status, isCurrent }: { storyId: string; revisionId: string; status: string; isCurrent: boolean }) {
  const review = useReviewRevision(storyId);
  const restore = useRestoreRevision(storyId);
  const navigate = useNavigate();
  const toast = useToast();
  const error = review.error ?? restore.error;

  return (
    <div className="review-bar">
      {status === 'pending' && (
        <>
          <span>This edit is waiting for review.</span>
          <button className="button button-primary" onClick={() => review.mutate({ revisionId, decision: 'accept' }, { onSuccess: () => { toast('Accepted'); navigate(`/s/${storyId}`); } })}>
            Accept
          </button>
          <button className="button button-danger" onClick={() => review.mutate({ revisionId, decision: 'reject' }, { onSuccess: () => toast('Rejected') })}>
            Reject
          </button>
        </>
      )}
      {status !== 'pending' && !isCurrent && (
        <button className="button" onClick={() => restore.mutate(revisionId, { onSuccess: () => { toast('Restored'); navigate(`/s/${storyId}`); } })}>
          Restore this version
        </button>
      )}
      {error && <p className="error-text">{errorMessage(error)}</p>}
    </div>
  );
}
