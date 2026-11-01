import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { formatCellLocation, isDisplayCell } from '@hexstory/shared';
import { useCellStories } from '../api/queries';
import { AdSlot } from '../components/AdSlot';
import { Panel } from '../components/Panel';
import { StoryRow } from '../components/StoryRow';
import { useMapState } from '../map/MapContext';
import { Square } from './Square';
import { NotFound } from './NotFound';

export function HexView() {
  const { cell = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'square' ? 'square' : 'stories';
  const { setActiveCell, focusCells } = useMapState();
  const valid = isDisplayCell(cell);

  useEffect(() => {
    if (!valid) return;
    setActiveCell(cell);
    focusCells([cell], { onlyIfHidden: true });
    return () => setActiveCell(null);
  }, [cell, valid, setActiveCell, focusCells]);

  if (!valid) return <NotFound what="region" />;

  return (
    <Panel
      title="This region"
      subtitle={formatCellLocation(cell)}
      footer={
        tab === 'stories' && (
          <Link className="button button-primary button-block" to={`/new?cell=${cell}`}>
            Write a story here
          </Link>
        )
      }
    >
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'stories'} onClick={() => setParams({}, { replace: true })}>
          Stories
        </button>
        <button role="tab" aria-selected={tab === 'square'} onClick={() => setParams({ tab: 'square' }, { replace: true })}>
          The Square
        </button>
      </div>
      {tab === 'stories' ? <StoryList cell={cell} /> : <Square cell={cell} />}
    </Panel>
  );
}

function StoryList({ cell }: { cell: string }) {
  const query = useCellStories(cell);
  const stories = query.data?.pages.flatMap((p) => p.items) ?? [];

  if (query.isLoading) return <p className="muted pad">Loading stories…</p>;
  if (query.error) return <p className="error-text pad">Couldn't load stories. Try again in a moment.</p>;
  if (stories.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No stories here yet.</p>
        <p className="muted">Know something that happened in this place? You could be the first to write it down.</p>
      </div>
    );
  }

  return (
    <div className="story-list">
      <p className="list-note">Most recent events first</p>
      {stories.map((s) => (
        <StoryRow key={s.id} story={s} fromCell={cell} />
      ))}
      {query.hasNextPage && (
        <button className="button button-block" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </button>
      )}
      <AdSlot placement="story-list-end" />
    </div>
  );
}
