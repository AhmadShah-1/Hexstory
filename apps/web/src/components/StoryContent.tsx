import { Link } from 'react-router';
import { formatEventDate, type StoryRevision } from '@hexstory/shared';
import { areaKm2 } from '../lib/format';
import { RichContent } from './RichContent';
import { SourceBadge } from './SourceBadge';

/** Renders one version of a story. */
export function StoryContent({ revision, cellCount }: { revision: StoryRevision; cellCount: number }) {
  return (
    <article className="story">
      <h2 className="story-title">{revision.title}</h2>
      <div className="story-meta">
        <span>{formatEventDate(revision)}</span>
        <SourceBadge count={revision.sources.length} />
        {cellCount > 1 && <span>covers about {areaKm2(cellCount)}</span>}
      </div>
      <RichContent doc={revision.content} />
      <p className="byline muted small">
        Last edited by {revision.author.displayName} · {new Date(revision.createdAt).toLocaleDateString()}
      </p>

      <h3 className="section-label">Sources</h3>
      <ol className="sources">
        {revision.sources.map((s, i) => (
          <li key={i}>
            {s.url ? (
              <a href={s.url} target="_blank" rel="nofollow ugc noopener noreferrer">
                {s.title}
              </a>
            ) : (
              s.title
            )}
            {s.url && <span className="source-host">{hostOf(s.url)}</span>}
          </li>
        ))}
      </ol>

      <p className="disclaimer">
        Written by community members. It reflects contributors' own views and has not been verified. Sources are
        listed but not checked. Text is available under{' '}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">
          CC BY-SA 4.0
        </a>
        . <Link to="/terms">Terms</Link>
      </p>
    </article>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
