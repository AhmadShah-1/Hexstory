import { useState } from 'react';
import { Link } from 'react-router';
import { formatDateParts, type Development, type StoryDetail } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useDevelopments, useModerateDevelopment } from '../api/queries';
import { ConfirmAction } from './ConfirmAction';
import { useToast } from './Toast';

/**
 * An event's timeline: dated developments, newest first, each with its own place and sources. The story
 * page shows the latest few; "Show all" loads the rest. Reviewers see held and removed ones, marked.
 */
export function Developments({ story, viewerId }: { story: StoryDetail; viewerId: string | undefined }) {
  const [all, setAll] = useState(false);
  const more = useDevelopments(story.id, all);
  const items = all && more.data ? more.data.pages.flatMap((p) => p.items) : story.developments;
  const canShowAll = !all && (story.developmentCount > story.developments.length || story.developments.length >= 5);
  if (!items.length && !story.can.addDevelopment) return null;

  return (
    <section className="timeline-section" aria-labelledby="timeline-heading">
      <h3 className="section-label" id="timeline-heading">
        Timeline{story.developmentCount > 0 && <span className="section-count"> · {story.developmentCount}</span>}
      </h3>
      {items.length === 0 ? (
        <p className="muted small">
          {story.revision.isOngoing ? 'Is something still unfolding? ' : ''}Add developments here instead of writing a separate story for each one.
        </p>
      ) : (
        <ol className="timeline">
          {items.map((d) => <DevelopmentItem key={d.id} dev={d} story={story} viewerId={viewerId} />)}
        </ol>
      )}
      <div className="row">
        {canShowAll && (
          <button type="button" className="link-button" onClick={() => setAll(true)}>
            Show the whole timeline{story.developmentCount > 0 ? ` (${story.developmentCount})` : ''}
          </button>
        )}
        {all && more.hasNextPage && (
          <button type="button" className="link-button" disabled={more.isFetchingNextPage} onClick={() => more.fetchNextPage()}>
            {more.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        )}
        {story.can.addDevelopment && <Link className="button" to={`/s/${story.id}/develop`}>Add a development</Link>}
      </div>
    </section>
  );
}

function DevelopmentItem({ dev, story, viewerId }: { dev: Development; story: StoryDetail; viewerId: string | undefined }) {
  const moderate = useModerateDevelopment(story.id);
  const toast = useToast();
  const reviewer = story.can.review;
  return (
    <li className={`timeline-item ${dev.status !== 'accepted' || dev.removed ? 'timeline-item-quiet' : ''}`}>
      <div className="timeline-date">{formatDateParts(dev.date)}</div>
      <div className="timeline-body">
        <strong className="timeline-title">{dev.title}</strong>
        <div className="small muted">
          {dev.location?.placeName && <span>{dev.location.placeName}</span>}
          {dev.removed && <span className="chip chip-rejected">Removed</span>}
          {!dev.removed && dev.status === 'pending' && <span className="chip chip-pending">Waiting for review</span>}
          {!dev.removed && dev.status === 'rejected' && <span className="chip chip-rejected">Not accepted</span>}
        </div>
        {dev.body && <p className="timeline-text">{dev.body}</p>}
        <ul className="timeline-sources">
          {dev.sources.map((s, i) => (
            <li key={i}>
              {s.url ? <a href={s.url} target="_blank" rel="nofollow ugc noopener noreferrer">{s.title}</a> : s.title}
            </li>
          ))}
        </ul>
        <p className="small muted">Added by <Link to={`/u/${dev.author.id}`}>{dev.author.displayName}</Link></p>
        {reviewer && !dev.removed && (
          <div className="row">
            {dev.status === 'pending' && dev.author.id !== viewerId && (
              <>
                <button className="button" disabled={moderate.isPending} onClick={() => moderate.mutate({ id: dev.id, action: 'accept' }, { onSuccess: () => toast('Added to the timeline') })}>
                  Accept
                </button>
                <button className="button button-danger" disabled={moderate.isPending} onClick={() => moderate.mutate({ id: dev.id, action: 'reject' }, { onSuccess: () => toast('Not accepted') })}>
                  Reject
                </button>
              </>
            )}
            <ConfirmAction
              label="Remove"
              explain="Removed developments are visible to reviewers only. Open reports about it are closed."
              busy={moderate.isPending}
              onConfirm={(reason, done) => moderate.mutate({ id: dev.id, action: 'remove', reason }, { onSuccess: () => { toast('Removed from the timeline'); done(); } })}
            />
          </div>
        )}
        {moderate.error && <p className="error-text">{errorMessage(moderate.error)}</p>}
      </div>
    </li>
  );
}
