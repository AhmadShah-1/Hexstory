import { Link } from 'react-router';
import { formatEventDate, type StorySummary } from '@hexstory/shared';
import { areaKm2 } from '../lib/format';
import { HexGlyph } from './HexGlyph';
import { SourceBadge } from './SourceBadge';

export function StoryRow({ story, fromCell }: { story: StorySummary; fromCell?: string }) {
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
          {story.status === 'unreviewed' && <span className="chip chip-quiet">New</span>}
        </div>
      </div>
    </Link>
  );
}
