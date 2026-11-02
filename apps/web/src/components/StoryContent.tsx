import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  DEVELOPING_DAYS,
  LINK_RELATIONS,
  RELATION_LABELS,
  formatEventDate,
  type StoryConnection,
  type StoryDetail,
  type StoryRevision,
} from '@hexstory/shared';
import { areaKm2 } from '../lib/format';
import { CategoryChips } from './Categories';
import { HexGlyph } from './HexGlyph';
import { formatLatLng } from './LocationField';
import { RichContent } from './RichContent';
import { SourceBadge } from './SourceBadge';

/**
 * One version of a story, laid out for readability and context: what, when and where, a short summary,
 * the sources and how it connects to other events come before the longer account.
 *
 * `story` (the story page) adds what belongs to the story rather than to this version: labels,
 * connections in both directions and collections. The page also passes the timeline and corrections,
 * which sit between the context and the full account (`timeline`) and after it (`corrections`).
 */
export function StoryContent({ revision, cellCount, story, notice, timeline, corrections, onShowOnMap }: {
  revision: StoryRevision;
  cellCount: number;
  story?: StoryDetail;
  notice?: ReactNode;
  timeline?: ReactNode;
  corrections?: ReactNode;
  onShowOnMap?: () => void;
}) {
  const point = revision.location ?? story?.point ?? null;
  const developing = revision.isOngoing || (story?.developments.some((d) => !d.removed && d.status === 'accepted' && Date.now() - new Date(d.createdAt).getTime() < DEVELOPING_DAYS * 86_400_000) ?? false);
  return (
    <article className="story">
      <h2 className="story-title">{revision.title}</h2>
      {story && (story.featured || developing || story.isHistorical || story.imported) && (
        <div className="story-labels">
          {story.featured && <span className="chip chip-quiet">Featured</span>}
          {developing && <span className="chip chip-developing">{revision.isOngoing ? 'Ongoing' : 'Developing'}</span>}
          {story.isHistorical && <span className="chip chip-quiet" title="An account of an older event, newly added">Newly documented history</span>}
          {/* Bulk-loaded from public sources (docs/IMPORT.md): say so, and invite corrections. */}
          {story.imported && (
            <span className="chip chip-quiet" title="Added in bulk from the public sources listed below. Spotted a mistake? Dispute it or edit the story.">
              Imported from public sources
            </span>
          )}
        </div>
      )}

      <dl className="story-facts">
        <div>
          <dt>When</dt>
          <dd>{formatEventDate(revision)}</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>
            {revision.location?.placeName ?? (point ? formatLatLng(point) : 'Not recorded')}
            {cellCount > 1 && <span className="muted"> · covers about {areaKm2(cellCount)}</span>}
            {onShowOnMap && point && (
              <> · <button type="button" className="link-button" onClick={onShowOnMap}>Show on map</button></>
            )}
          </dd>
        </div>
        {revision.categories.length > 0 && (
          <div>
            <dt>Kind</dt>
            <dd><CategoryChips categories={revision.categories} /></dd>
          </div>
        )}
      </dl>

      {notice}
      {revision.summary && <p className="story-summary">{revision.summary}</p>}

      <h3 className="section-label">
        Sources <SourceBadge count={revision.sources.length} />
      </h3>
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

      {story && <Connections connections={story.connections} />}

      {revision.people.length > 0 && (
        <>
          <h3 className="section-label">People</h3>
          <ul className="people-chips people-links">
            {revision.people.map((p) => (
              <li key={p}><Link to={`/explore?person=${encodeURIComponent(p)}`}>{p}</Link></li>
            ))}
          </ul>
        </>
      )}

      {story && story.collections.length > 0 && (
        <>
          <h3 className="section-label">In collections</h3>
          <ul className="collection-links">
            {story.collections.map((c) => (
              <li key={c.id}><Link to={`/c/${c.id}`}>{c.title}</Link>{c.kind === 'place' && <span className="muted small"> · place</span>}</li>
            ))}
          </ul>
        </>
      )}

      {timeline}

      <h3 className="section-label">The full account</h3>
      <div className="story-account">
        <RichContent doc={revision.content} />
      </div>
      <p className="byline muted small">
        Last edited by <Link to={`/u/${revision.author.id}`}>{revision.author.displayName}</Link> ·{' '}
        {new Date(revision.createdAt).toLocaleDateString()}
      </p>

      {corrections}

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

/** Links to other stories, grouped by how they relate (in reading order: causes, consequences, wholes, parts). */
function Connections({ connections }: { connections: StoryConnection[] }) {
  if (!connections.length) return null;
  return (
    <>
      <h3 className="section-label">Connected events</h3>
      <div className="connections">
        {LINK_RELATIONS.map((relation) => {
          const group = connections.filter((c) => c.relation === relation);
          if (!group.length) return null;
          return (
            <div key={relation} className="connection-group">
              <div className="connection-label">{RELATION_LABELS[relation]}</div>
              <ul>
                {group.map((c) => (
                  <li key={c.story.id}>
                    <Link to={`/s/${c.story.id}`} className="connection">
                      <span className="connection-thumb">{c.story.thumbUrl ? <img src={c.story.thumbUrl} alt="" loading="lazy" /> : <HexGlyph />}</span>
                      <span>
                        <span className="connection-title">{c.story.title}</span>
                        <span className="muted small">{formatEventDate(c.story)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
