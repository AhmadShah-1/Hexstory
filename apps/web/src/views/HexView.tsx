import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { formatCellLocation, isDisplayCell, type StoryKind, type StorySort } from '@hexstory/shared';
import { useCellStories } from '../api/queries';
import { AdSlot } from '../components/AdSlot';
import { Panel } from '../components/Panel';
import { SortControls } from '../components/SortControls';
import { StoryRow } from '../components/StoryRow';
import { filtersQuery, hasFilters, useMapState } from '../map/MapContext';
import { NotFound } from './NotFound';

/**
 * A region's stories (manual exploration: a click on the map anywhere but a dot). Hexagons are only how
 * the map groups places; stories found here are those whose point or area falls inside it.
 */
export function HexView() {
  const { cell = '' } = useParams();
  const { setActiveCell, focusCells } = useMapState();
  const valid = isDisplayCell(cell);
  // Arriving from the place search: always fly there, and name the place the hexagon was chosen for.
  const arrival = useLocation().state as { focus?: boolean; placeName?: string } | null;
  const forceFocus = !!arrival?.focus;

  useEffect(() => {
    if (!valid) return;
    setActiveCell(cell);
    focusCells([cell], { onlyIfHidden: !forceFocus });
    return () => setActiveCell(null);
  }, [cell, valid, forceFocus, setActiveCell, focusCells]);

  if (!valid) return <NotFound what="region" />;

  return (
    <Panel
      title="This region"
      subtitle={arrival?.placeName ? `Around ${arrival.placeName} · ${formatCellLocation(cell)}` : formatCellLocation(cell)}
      footer={
        <Link className="button button-primary button-block" to={`/new?cell=${cell}`}>
          Write a story here
        </Link>
      }
    >
      <StoryList cell={cell} />
    </Panel>
  );
}

function StoryList({ cell }: { cell: string }) {
  const { filters } = useMapState();
  const [order, setOrder] = useState<{ sort: StorySort; kind: StoryKind }>({ sort: 'relevance', kind: 'all' });
  const query = useCellStories(cell, { ...order, ...filtersQuery(filters) });
  const stories = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="story-list">
      <div className="hex-list-head">
        <SortControls sort={order.sort} kind={order.kind} relevance onChange={setOrder} />
        {hasFilters(filters) && <p className="muted small">Showing stories that match the map filters.</p>}
      </div>
      {query.isLoading && <p className="muted pad">Loading stories…</p>}
      {query.error && <p className="error-text pad">Couldn't load stories. Try again in a moment.</p>}
      {query.data && stories.length === 0 && (
        <div className="empty">
          <p className="empty-title">{hasFilters(filters) ? 'Nothing here matches the filters.' : 'Nothing written about this area yet.'}</p>
          <p className="muted">
            Know something that happened here? You could write it down. Or{' '}
            <Link to="/near">see what happened near you</Link>, <Link to="/explore">explore all stories</Link>, or{' '}
            <Link to="/">go back to discovering</Link>.
          </p>
        </div>
      )}
      {stories.map((s) => (
        <StoryRow key={s.id} story={s} fromCell={cell} />
      ))}
      {query.hasNextPage && (
        <button className="button button-block" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
      {stories.length > 0 && <AdSlot placement="story-list-end" />}
    </div>
  );
}
