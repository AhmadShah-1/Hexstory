import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatEventDate, type StorySummary } from '@hexstory/shared';
import { areaKm2 } from '../lib/format';
import { HexGlyph } from './HexGlyph';
import { SourceBadge } from './SourceBadge';

/** `note` replaces the status chip, e.g. with a contribution's state. */
export function StoryRow({ story, fromCell, note }: { story: StorySummary; fromCell?: string; note?: ReactNode }) {
  return (
    <Link to={`/s/${story.id}`} state={fromCell ? { fromCell } : undefined} className="story-row">
      <div className="thumb">
        {story.thumbUrl ? <img src={story.thumbUrl} alt="" loading="lazy" /> : <HexGlyph />}
      </div>
      <div className="story-row-text">
        <div className="story-row-title">{story.title}</div>
        <div className="story-row-meta">
          <span>{formatEventDate(story)}</span>
          <SourceBadge count={story.sourceCount} />
          {story.cellCount > 1 && <span>~{areaKm2(story.cellCount)}</span>}
          {/* Only the person who started it and reviewers ever see unreviewed stories. */}
          {note ?? (story.status === 'unreviewed' && <span className="chip chip-quiet">Waiting for review</span>)}
        </div>
      </div>
    </Link>
  );
}
