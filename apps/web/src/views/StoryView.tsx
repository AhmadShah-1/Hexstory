import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { TRUST } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { signInUrl, useSession, useSetProtection, useSetStoryStatus, useStory } from '../api/queries';
import { AdSlot } from '../components/AdSlot';
import { Panel } from '../components/Panel';
import { ReportDialog } from '../components/ReportDialog';
import { StoryContent } from '../components/StoryContent';
import { useToast } from '../components/Toast';
import { useMapState } from '../map/MapContext';
import { NotFound } from './NotFound';

export function StoryView() {
  const { id = '' } = useParams();
  const location = useLocation();
  const fromCell = (location.state as { fromCell?: string } | null)?.fromCell;
  const story = useStory(id);
  const session = useSession();
  const { setStoryCells, focusCells } = useMapState();
  const [reporting, setReporting] = useState(false);
  const toast = useToast();

  const cells = story.data?.revision.cells;
  useEffect(() => {
    if (!cells) return;
    setStoryCells(cells);
    focusCells(cells, { onlyIfHidden: !!fromCell });
    return () => setStoryCells([]);
  }, [cells, fromCell, setStoryCells, focusCells]);

  if (story.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading story…</p></Panel>;
  if (!story.data) return <NotFound what="story" />;
  const { revision, can, pendingCount, status } = story.data;
  const signedIn = !!session.data?.user;

  const share = async () => {
    const url = `${window.location.origin}/s/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  return (
    <Panel
      title="Story"
      back={fromCell ? { label: 'Stories in this region', to: `/h/${fromCell}` } : undefined}
      subtitle={status === 'hidden' ? 'Hidden from the public' : status === 'unreviewed' ? 'New, not yet looked at by a reviewer' : undefined}
    >
      <div className="pad">
        {pendingCount > 0 &&
          (can.review ? (
            <Link to={`/s/${id}/versions`} className="notice">
              {pendingCount} suggested {pendingCount === 1 ? 'edit is' : 'edits are'} waiting for review
            </Link>
          ) : (
            <p className="notice">
              {pendingCount} suggested {pendingCount === 1 ? 'edit is' : 'edits are'} waiting for review
            </p>
          ))}
        <StoryContent revision={revision} cellCount={story.data.cellCount} />

        <div className="action-row">
          {can.edit ? (
            <Link className="button" to={`/s/${id}/edit`}>Edit</Link>
          ) : (
            !signedIn && <a className="button" href={signInUrl(`/s/${id}/edit`)}>Edit</a>
          )}
          <Link className="button" to={`/s/${id}/versions`}>Versions</Link>
          <button className="button" onClick={share}>Share</button>
          {signedIn && <button className="button button-quiet" onClick={() => setReporting(true)}>Report</button>}
        </div>

        {can.review && <ReviewerTools storyId={id} status={status} protectionLevel={story.data.protectionLevel} isModerator={(session.data?.user?.trustLevel ?? 0) >= TRUST.MODERATOR} />}
        <AdSlot placement="story-end" />
      </div>
      {reporting && <ReportDialog open onClose={() => setReporting(false)} targetType="story" targetId={id} />}
    </Panel>
  );
}

function ReviewerTools({ storyId, status, protectionLevel, isModerator }: {
  storyId: string;
  status: string;
  protectionLevel: number;
  isModerator: boolean;
}) {
  const setStatus = useSetStoryStatus(storyId);
  const setProtection = useSetProtection(storyId);
  const error = setStatus.error ?? setProtection.error;
  return (
    <details className="reviewer-tools">
      <summary>Reviewer tools</summary>
      <div className="action-row">
        {status === 'unreviewed' && (
          <button className="button" onClick={() => setStatus.mutate('active')}>Mark as reviewed</button>
        )}
        {status === 'hidden' ? (
          isModerator && <button className="button" onClick={() => setStatus.mutate('active')}>Unhide</button>
        ) : (
          <button className="button button-danger" onClick={() => setStatus.mutate('hidden')}>Hide story</button>
        )}
      </div>
      {isModerator && (
        <label className="field">
          <span>Who can edit without review</span>
          <select
            value={protectionLevel}
            onChange={(e) => setProtection.mutate(Number(e.target.value) as 0 | 1 | 2 | 3)}
          >
            <option value={0}>Members (default)</option>
            <option value={2}>Reviewers only</option>
            <option value={3}>Moderators only</option>
          </select>
        </label>
      )}
      {error && <p className="error-text">{errorMessage(error)}</p>}
    </details>
  );
}
