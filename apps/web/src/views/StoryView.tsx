import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { TRUST } from '@hexstory/shared';
import { ApiError, errorMessage } from '../api/client';
import { signInUrl, useSession, useSetProtection, useSetStoryStatus, useStory } from '../api/queries';
import { AdSlot } from '../components/AdSlot';
import { Panel } from '../components/Panel';
import { ReportDialog } from '../components/ReportDialog';
import { StoryContent } from '../components/StoryContent';
import { useToast } from '../components/Toast';
import { useMapState } from '../map/MapContext';
import { ConfirmAction } from '../components/ConfirmAction';
import { LoadFailed, NotFound } from './NotFound';

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
  if (!story.data) return story.error ? <LoadFailed error={story.error} what="story" retry={() => story.refetch()} /> : <NotFound what="story" />;
  const { revision, can, pendingCount, status, createdBy } = story.data;
  const viewer = session.data?.user;
  const signedIn = !!viewer;
  // A story with no current version shows its first one: held (waiting) or turned down (not accepted).
  const notAccepted = revision.status === 'rejected';
  // Not public yet: a newcomer's story awaiting approval, or a story whose first version is held.
  const waiting = !notAccepted && (status === 'unreviewed' || revision.status === 'pending');

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
      subtitle={status === 'hidden' ? 'Hidden from the public' : notAccepted ? 'Not accepted · not public' : waiting
        ? `Waiting for a reviewer · ${viewer?.id === createdBy.id ? 'only you and reviewers can see it' : 'not public yet'}`
        : undefined}
    >
      <div className="pad">
        {notAccepted && viewer?.id === createdBy.id && (
          <p className="notice">A reviewer didn't accept this story, so it won't be published. You can write a new one.</p>
        )}
        {waiting && viewer?.id === createdBy.id && (
          <p className="notice">
            Your story will be published once a reviewer approves it.
            {status === 'unreviewed' && revision.status !== 'pending' && ' You can keep editing it until then.'}
          </p>
        )}
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

        {can.review && (
          <ReviewerTools
            storyId={id}
            revisionId={revision.id}
            revisionStatus={revision.status}
            status={status}
            createdBy={createdBy}
            isOwn={viewer?.id === createdBy.id}
            protectionLevel={story.data.protectionLevel}
            isModerator={(viewer?.trustLevel ?? 0) >= TRUST.MODERATOR}
            onStale={() => story.refetch()}
          />
        )}
        <AdSlot placement="story-end" />
      </div>
      {reporting && <ReportDialog open onClose={() => setReporting(false)} targetType="story" targetId={id} />}
    </Panel>
  );
}

function ReviewerTools({ storyId, revisionId, revisionStatus, status, createdBy, isOwn, protectionLevel, isModerator, onStale }: {
  storyId: string;
  revisionId: string;
  revisionStatus: string;
  status: string;
  createdBy: { id: string; displayName: string };
  isOwn: boolean;
  protectionLevel: number;
  isModerator: boolean;
  onStale: () => void;
}) {
  const setStatus = useSetStoryStatus(storyId);
  const setProtection = useSetProtection(storyId);
  const toast = useToast();
  const error = setStatus.error ?? setProtection.error;

  // Approval names the version on screen; if the author changed it since, reload so the reviewer sees the new text.
  const approve = () =>
    setStatus.mutate(
      { status: 'active', revisionId },
      {
        onSuccess: () => toast('Approved. The story is now public.'),
        onError: (err) => { if (err instanceof ApiError && err.code === 'stale') onStale(); },
      },
    );

  return (
    <details className="reviewer-tools" open={status === 'unreviewed' && !isOwn ? true : undefined}>
      <summary>Reviewer tools</summary>
      {status === 'unreviewed' && (
        <p className="small reviewer-note">
          Started by <Link to={`/u/${createdBy.id}`}>{createdBy.displayName}</Link>. It's private until a reviewer approves it.
        </p>
      )}
      <div className="action-row">
        {status === 'unreviewed' && !isOwn && revisionStatus === 'accepted' && (
          <button className="button button-primary" disabled={setStatus.isPending} onClick={approve}>Approve and publish</button>
        )}
        {/* Its first version is held: reviewing that version is what publishes the story. */}
        {status === 'unreviewed' && !isOwn && revisionStatus === 'pending' && (
          <Link className="button button-primary" to={`/v/${revisionId}`}>Review the first version</Link>
        )}
        {status === 'hidden' ? (
          isModerator && (
            <button
              className="button"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ status: 'active' }, {
                onSuccess: (res) => toast(res.status === 'unreviewed' ? 'Back in the review queue: it was never approved.' : 'Brought back. The story is public again.'),
              })}
            >
              Unhide
            </button>
          )
        ) : (
          <ConfirmAction
            label="Hide story"
            explain={isModerator
              ? 'Hidden stories are visible only to reviewers. Open reports about it are closed.'
              : 'Hidden stories are visible only to reviewers, and only a moderator can bring it back. Open reports about it are closed.'}
            busy={setStatus.isPending}
            onConfirm={(reason, done) => setStatus.mutate({ status: 'hidden', reason }, { onSuccess: () => { toast('Story hidden'); done(); } })}
          />
        )}
      </div>
      {isModerator && (
        <label className="field">
          <span>Who can edit without review</span>
          <select
            // Level 1 means the same as the default (Members), so it shows as such.
            value={protectionLevel <= TRUST.MEMBER ? 0 : protectionLevel}
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
