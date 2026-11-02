import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { LIMITS, TRUST, type StoryDetail } from '@hexstory/shared';
import { ApiError, errorMessage } from '../api/client';
import { signInUrl, useSession, useSetFeatured, useSetProtection, useSetStoryStatus, useStory } from '../api/queries';
import { AdSlot } from '../components/AdSlot';
import { CorrectionDialog } from '../components/CorrectionDialog';
import { Corrections } from '../components/Corrections';
import { Developments } from '../components/Developments';
import { Panel } from '../components/Panel';
import { ReportDialog } from '../components/ReportDialog';
import { StoryContent } from '../components/StoryContent';
import { useToast } from '../components/Toast';
import { useMapState, type MapMarker } from '../map/MapContext';
import { ConfirmAction } from '../components/ConfirmAction';
import { LoadFailed, NotFound } from './NotFound';

export function StoryView() {
  const { id = '' } = useParams();
  const location = useLocation();
  const fromCell = (location.state as { fromCell?: string } | null)?.fromCell;
  const story = useStory(id);
  const session = useSession();
  const [reporting, setReporting] = useState(false);
  const [disputing, setDisputing] = useState<string | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const showOnMap = useStoryOnMap(story.data, !!fromCell);

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

  /** Text the reader selected inside the story becomes the quote they dispute. */
  const dispute = () => {
    const selection = window.getSelection();
    const inStory = selection && articleRef.current && selection.rangeCount > 0 && articleRef.current.contains(selection.getRangeAt(0).commonAncestorContainer);
    setDisputing(inStory ? selection.toString().trim().slice(0, LIMITS.correctionQuoteMax) : '');
  };

  return (
    <Panel
      title="Story"
      back={fromCell ? { label: 'Stories in this region', to: `/h/${fromCell}` } : undefined}
      subtitle={status === 'hidden' ? 'Hidden from the public' : notAccepted ? 'Not accepted · not public' : waiting
        ? `Waiting for a reviewer · ${viewer?.id === createdBy.id ? 'only you and reviewers can see it' : 'not public yet'}`
        : undefined}
    >
      <div className="pad" ref={articleRef}>
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
        <StoryContent
          revision={revision}
          cellCount={story.data.cellCount}
          story={story.data}
          onShowOnMap={showOnMap}
          notice={story.data.openCorrections > 0 && (
            <a href="#corrections" className="notice notice-disputed">
              {story.data.openCorrections === 1 ? 'A statement in this story is' : `${story.data.openCorrections} statements in this story are`} disputed. See the corrections below.
            </a>
          )}
          timeline={<Developments story={story.data} viewerId={viewer?.id} />}
          corrections={<Corrections story={story.data} viewer={viewer ?? undefined} onDispute={can.correct ? dispute : null} />}
        />

        <div className="action-row">
          {can.edit ? (
            <Link className="button" to={`/s/${id}/edit`}>Edit</Link>
          ) : (
            !signedIn && <a className="button" href={signInUrl(`/s/${id}/edit`)}>Edit</a>
          )}
          <Link className="button" to={`/s/${id}/versions`}>Versions</Link>
          <button className="button" onClick={share}>Share</button>
          {!signedIn && status === 'active' && <a className="button" href={signInUrl(`/s/${id}#corrections`)}>Dispute a statement</a>}
          {signedIn && <button className="button button-quiet" onClick={() => setReporting(true)}>Report</button>}
        </div>

        {can.review && (
          <ReviewerTools
            story={story.data}
            isOwn={viewer?.id === createdBy.id}
            isModerator={(viewer?.trustLevel ?? 0) >= TRUST.MODERATOR}
            onStale={() => story.refetch()}
          />
        )}
        <AdSlot placement="story-end" />
      </div>
      {reporting && <ReportDialog open onClose={() => setReporting(false)} targetType="story" targetId={id} />}
      {disputing !== null && (
        <CorrectionDialog open onClose={() => setDisputing(null)} storyId={id} revisionId={revision.id} initialQuote={disputing} />
      )}
    </Panel>
  );
}

/**
 * Shows the story on the map while it is open: its point as a pin, its wider area (only when it has one),
 * and its developments' places as labelled markers. Returns the "Show on map" action.
 */
function useStoryOnMap(story: StoryDetail | undefined, cameFromRegion: boolean): (() => void) | undefined {
  const { setStoryCells, setStoryPoint, setMarkers, focusCells, focusPoints } = useMapState();
  const point = story?.point;
  const cells = story && story.cellCount > 1 ? story.revision.cells : null;
  const markers: MapMarker[] = (story?.developments ?? [])
    .filter((d) => d.location && !d.removed)
    .map((d) => ({ id: d.id, lat: d.location!.lat, lng: d.location!.lng, label: d.title }));
  const markerKey = JSON.stringify(markers);
  const pointKey = point ? `${point.lat},${point.lng}` : '';

  const show = (onlyIfHidden: boolean) => {
    if (cells) focusCells(cells, { onlyIfHidden });
    else if (point) focusPoints([point, ...markers], { onlyIfHidden, maxZoom: 9 });
  };

  useEffect(() => {
    if (!story) return;
    setStoryPoint(point ?? null);
    setStoryCells(cells ?? []);
    setMarkers(markers);
    // Arriving from a region list: the camera is already there; only move if the story is out of view.
    show(cameFromRegion);
    return () => {
      setStoryPoint(null);
      setStoryCells([]);
      setMarkers([]);
    };
    // Re-run when what is drawn changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, pointKey, cells?.join(','), markerKey, cameFromRegion]);

  return story ? () => show(false) : undefined;
}

function ReviewerTools({ story, isOwn, isModerator, onStale }: {
  story: StoryDetail;
  isOwn: boolean;
  isModerator: boolean;
  onStale: () => void;
}) {
  const { id: storyId, revision, status, createdBy, protectionLevel } = story;
  const revisionId = revision.id;
  const revisionStatus = revision.status;
  const setStatus = useSetStoryStatus(storyId);
  const setProtection = useSetProtection(storyId);
  const setFeatured = useSetFeatured(storyId);
  const toast = useToast();
  const error = setStatus.error ?? setProtection.error ?? setFeatured.error;

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
        {story.can.feature && (
          <button
            className="button"
            disabled={setFeatured.isPending}
            onClick={() => setFeatured.mutate(!story.featured, { onSuccess: () => toast(story.featured ? 'No longer featured' : 'Featured on the home page') })}
          >
            {story.featured ? 'Stop featuring' : 'Feature on the home page'}
          </button>
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
