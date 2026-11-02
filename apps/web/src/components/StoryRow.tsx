import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatEventDate, type StorySummary } from '@hexstory/shared';
import { CategoryChips } from './Categories';
import { HexGlyph } from './HexGlyph';
import { SourceBadge } from './SourceBadge';

/**
 * One story in a list: what, when, where and a one-line summary, so a reader can choose without opening it.
 * `note` replaces the status chip, e.g. with a contribution's state. `linked={false}` renders the row
 * without a link, for stories the viewer can't open (a hidden story, to its author). `compact` drops the
 * summary (dense lists such as the home page's side sections).
 */
export function StoryRow({ story, fromCell, note, linked = true, compact = false }: {
  story: StorySummary;
  fromCell?: string;
  note?: ReactNode;
  linked?: boolean;
  compact?: boolean;
}) {
  const body = (
    <>
      <div className="thumb">
        {story.thumbUrl ? <img src={story.thumbUrl} alt="" loading="lazy" /> : <HexGlyph />}
      </div>
      <div className="story-row-text">
        <div className="story-row-title">{story.title}</div>
        <div className="story-row-meta">
          <span>{formatEventDate(story)}</span>
          {story.placeName && <span className="story-row-place">{story.placeName}</span>}
          {story.developing && <span className="chip chip-developing">{story.isOngoing ? 'Ongoing' : 'Developing'}</span>}
          {story.isHistorical && story.publishedAt && <span className="chip chip-quiet" title="An account of an older event, newly added">Newly documented</span>}
          {/* Only the person who started it and reviewers ever see unreviewed stories. */}
          {note ?? (story.status === 'unreviewed' && <span className="chip chip-quiet">Waiting for review</span>)}
        </div>
        {!compact && story.summary && <p className="story-row-summary">{story.summary}</p>}
        {!compact && (
          <div className="story-row-meta">
            <CategoryChips categories={story.categories} small />
            <SourceBadge count={story.sourceCount} />
          </div>
        )}
      </div>
    </>
  );
  if (!linked) return <div className="story-row">{body}</div>;
  return (
    <Link to={`/s/${story.id}`} state={fromCell ? { fromCell } : undefined} className="story-row">
      {body}
    </Link>
  );
}
