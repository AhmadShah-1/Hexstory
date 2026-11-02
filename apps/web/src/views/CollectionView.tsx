import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  CATEGORY_LABELS,
  TRUST,
  baseCellCount,
  eventRange,
  type CollectionDetail,
  type StorySummary,
} from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useCollection, useMapPoints, useModerateCollection, useSession } from '../api/queries';
import { ConfirmAction } from '../components/ConfirmAction';
import { Panel } from '../components/Panel';
import { ReportDialog } from '../components/ReportDialog';
import { StoryRow } from '../components/StoryRow';
import { useToast } from '../components/Toast';
import { areaKm2 } from '../lib/format';
import { useMapState } from '../map/MapContext';
import { LoadFailed, NotFound } from './NotFound';

type Order = 'arranged' | 'date';

const yearText = (y: number) => (y < 0 ? `${-y} BCE` : String(y));

/** The collection's rules in words, e.g. "Everything in an area of about 12,000 km², about protests, from 1900 to 1999". */
function describeRules(c: CollectionDetail): string | null {
  const parts: string[] = [];
  if (c.cells.length) parts.push(`in an area of about ${areaKm2(baseCellCount(c.cells))}`);
  if (c.categories.length) parts.push(`about ${c.categories.map((k) => CATEGORY_LABELS[k].toLowerCase()).join(', ')}`);
  if (c.fromYear != null && c.toYear != null) parts.push(`from ${yearText(c.fromYear)} to ${yearText(c.toYear)}`);
  else if (c.fromYear != null) parts.push(`from ${yearText(c.fromYear)} onwards`);
  else if (c.toYear != null) parts.push(`up to ${yearText(c.toYear)}`);
  return parts.length ? `Also gathers every published story ${parts.join(', ')}.` : null;
}

/** Heading for a group of years: decades for collections spanning a few centuries or less, centuries otherwise. */
function periodHeading(year: number, unit: 10 | 100): string {
  const abs = Math.abs(year);
  const start = Math.floor(abs / unit) * unit;
  if (start === 0) return year < 0 ? `1–${unit - 1} BCE` : `1–${unit - 1}`;
  return year < 0 ? `${start}s BCE` : `${start}s`;
}

/**
 * One collection (/c/:id): read in the curator's order or by date, with every story highlighted on the
 * map and the area of a place collection drawn as its footprint.
 */
export function CollectionView() {
  const { id = '' } = useParams();
  const collection = useCollection(id);
  const points = useMapPoints();
  const { setHighlight, setStoryCells, focusCells, focusPoints } = useMapState();
  const [order, setOrder] = useState<Order>('arranged');
  const [reporting, setReporting] = useState(false);
  const c = collection.data;

  const stories = useMemo(() => (c ? [...c.items.map((i) => i.story), ...c.matched] : []), [c]);
  const ids = useMemo(() => stories.map((s) => s.id), [stories]);

  // Emphasise the collection's stories and draw a place's area while it's open.
  useEffect(() => {
    if (!c) return;
    setHighlight(ids);
    setStoryCells(c.cells);
    return () => {
      setHighlight(null);
      setStoryCells([]);
    };
  }, [c, ids, setHighlight, setStoryCells]);

  // Move the map once per collection: to the area, or to wherever its stories are.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!c || focused.current === c.id) return;
    if (c.cells.length) {
      focusCells(c.cells);
      focused.current = c.id;
      return;
    }
    if (!points.data) return;
    const wanted = new Set(ids);
    const located = points.data.filter((p) => wanted.has(p.id));
    if (located.length) focusPoints(located.map(({ lat, lng }) => ({ lat, lng })));
    focused.current = c.id;
  }, [c, ids, points.data, focusCells, focusPoints]);

  if (collection.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading collection…</p></Panel>;
  if (!c) return collection.error ? <LoadFailed error={collection.error} what="collection" retry={() => collection.refetch()} /> : <NotFound what="collection" />;

  const rules = describeRules(c);
  return (
    <Panel
      title={c.title}
      subtitle={`${c.kind === 'place' ? 'Place' : 'Theme'} collection · ${c.storyCount === 1 ? '1 story' : `${c.storyCount} stories`}`}
      back={{ label: 'All collections', to: '/collections' }}
    >
      <div className="pad">
        {c.status === 'hidden' && <p className="notice notice-danger">This collection is hidden from the public.</p>}
        <p className="collection-description">{c.description}</p>
        <p className="muted small">
          Curated by <Link to={`/u/${c.createdBy.id}`}>{c.createdBy.displayName}</Link>
          {c.items.length > 0 && ` · ${c.items.length} picked by hand`}
        </p>
        {rules && <p className="small collection-rules">{rules}</p>}

        <div className="segmented collection-order" role="radiogroup" aria-label="Order">
          <label>
            <input type="radio" name="order" checked={order === 'arranged'} onChange={() => setOrder('arranged')} />
            As arranged
          </label>
          <label>
            <input type="radio" name="order" checked={order === 'date'} onChange={() => setOrder('date')} />
            By date
          </label>
        </div>
      </div>

      {stories.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No stories here yet.</p>
          <p className="muted">{rules ? 'Stories that match will appear as they are published.' : 'The curator hasn’t added any stories yet.'}</p>
        </div>
      ) : order === 'arranged' ? (
        <Arranged collection={c} />
      ) : (
        <ByDate stories={stories} />
      )}
      {c.matchedTotal > c.matched.length && (
        <p className="muted small pad-x">
          Showing the first {c.matched.length} of {c.matchedTotal} stories that match. <Link to="/explore">Explore</Link> with
          filters to see more.
        </p>
      )}

      <div className="pad">
        <CollectionActions collection={c} onReport={() => setReporting(true)} />
      </div>
      {reporting && <ReportDialog open onClose={() => setReporting(false)} targetType="collection" targetId={c.id} />}
    </Panel>
  );
}

/** The curator's order with their notes, then the stories the rules gathered, oldest first. */
function Arranged({ collection: c }: { collection: CollectionDetail }) {
  return (
    <div className="story-list">
      {c.items.map(({ story, note }) => (
        <div key={story.id} className="collection-item">
          <StoryRow story={story} />
          {note && <p className="collection-note small">{note}</p>}
        </div>
      ))}
      {c.matched.length > 0 && (
        <>
          {c.items.length > 0 && <p className="list-note">Also in this collection, by date</p>}
          {c.matched.map((s) => (
            <StoryRow key={s.id} story={s} />
          ))}
        </>
      )}
    </div>
  );
}

/** Everything, oldest first, under decade or century headings. */
function ByDate({ stories }: { stories: StorySummary[] }) {
  const sorted = [...stories].sort((a, b) => eventRange(a).lo - eventRange(b).lo);
  const years = sorted.map((s) => s.start.year);
  const unit = Math.max(...years) - Math.min(...years) > 300 ? 100 : 10;
  const groups: { heading: string; stories: StorySummary[] }[] = [];
  for (const s of sorted) {
    const heading = periodHeading(s.start.year, unit);
    if (groups.at(-1)?.heading !== heading) groups.push({ heading, stories: [] });
    groups.at(-1)!.stories.push(s);
  }
  return (
    <div className="story-list">
      {groups.map((g) => (
        <section key={g.heading} aria-label={g.heading}>
          <h3 className="collection-period">{g.heading}</h3>
          {g.stories.map((s) => (
            <StoryRow key={s.id} story={s} />
          ))}
        </section>
      ))}
    </div>
  );
}

function CollectionActions({ collection: c, onReport }: { collection: CollectionDetail; onReport: () => void }) {
  const viewer = useSession().data?.user;
  const moderate = useModerateCollection(c.id);
  const toast = useToast();
  const isModerator = (viewer?.trustLevel ?? 0) >= TRUST.MODERATOR;

  const share = async () => {
    const url = `${window.location.origin}/c/${c.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  return (
    <>
      <div className="action-row">
        {c.can.edit && <Link className="button" to={`/c/${c.id}/edit`}>Edit</Link>}
        <button className="button" onClick={share}>Share</button>
        {c.can.feature && (
          <button
            className="button"
            disabled={moderate.isPending}
            onClick={() => moderate.mutate({ featured: !c.featured }, { onSuccess: () => toast(c.featured ? 'No longer featured' : 'Featured on the home page') })}
          >
            {c.featured ? 'Unfeature' : 'Feature on the home page'}
          </button>
        )}
        {viewer && <button className="button button-quiet" onClick={onReport}>Report</button>}
      </div>
      {c.can.hide && c.status === 'active' && (
        <ConfirmAction
          label="Hide collection"
          explain={`Hidden collections are visible only to reviewers${isModerator ? '' : ', and only a moderator can bring one back'}. The stories in it are not affected. Open reports about it are closed.`}
          busy={moderate.isPending}
          onConfirm={(reason, done) => moderate.mutate({ status: 'hidden', reason }, { onSuccess: () => { toast('Collection hidden'); done(); } })}
        />
      )}
      {c.status === 'hidden' && isModerator && (
        <button className="button" disabled={moderate.isPending} onClick={() => moderate.mutate({ status: 'active' }, { onSuccess: () => toast('Collection brought back') })}>
          Unhide
        </button>
      )}
      {moderate.error && <p className="error-text">{errorMessage(moderate.error)}</p>}
    </>
  );
}
