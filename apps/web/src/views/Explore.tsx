import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  STORY_KINDS,
  STORY_SORTS,
  type Category,
  type StoryKind,
  type StorySort,
} from '@hexstory/shared';
import { useStoryList, type StoryFilters } from '../api/queries';
import { Panel } from '../components/Panel';
import { SortControls } from '../components/SortControls';
import { StoryRow } from '../components/StoryRow';
import { describeRange } from '../lib/discover';
import { NO_FILTERS, filtersQuery, hasFilters, useMapState } from '../map/MapContext';

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined =>
  allowed.includes(value as T) ? (value as T) : undefined;

/** "03-07" → "7 March". */
function dayLabel(on: string): string {
  const [m, d] = on.split('-').map(Number);
  if (!m || !d) return on;
  return new Date(2000, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/**
 * Any list of stories, described by the URL: a search (`q`), a person, "on this day" (`on=MM-DD`),
 * developing events (`ongoing=1`), a kind and an ordering. It also follows the map's time and category
 * filters, with the URL winning where both say something. The listed stories are highlighted on the map.
 */
export function Explore() {
  const [params, setParams] = useSearchParams();
  const { filters, setFilters, setHighlight } = useMapState();

  const q = params.get('q')?.trim() || undefined;
  const person = params.get('person')?.trim() || undefined;
  const on = /^\d{1,2}-\d{1,2}$/.test(params.get('on') ?? '') ? params.get('on')! : undefined;
  const ongoing = params.get('ongoing') === '1' ? ('1' as const) : undefined;
  const urlCategories = (params.get('categories') ?? '').split(',').filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));
  const sort: StorySort = pick(params.get('sort'), STORY_SORTS) ?? (q ? 'relevance' : 'occurred');
  const kind: StoryKind = pick(params.get('kind'), STORY_KINDS) ?? 'all';

  const catsKey = urlCategories.join(',');
  const query: StoryFilters = useMemo(
    () => ({
      ...filtersQuery(filters),
      ...(catsKey ? { categories: catsKey.split(',') as Category[] } : {}),
      sort: sort === 'relevance' && !q ? 'occurred' : sort,
      kind,
      q,
      person,
      on,
      ongoing,
    }),
    [filters, catsKey, sort, kind, q, person, on, ongoing],
  );
  const list = useStoryList(query);
  const stories = list.data?.pages.flatMap((p) => p.items) ?? [];

  const ids = stories.map((s) => s.id).join(',');
  useEffect(() => {
    setHighlight(ids ? ids.split(',') : []);
  }, [ids, setHighlight]);
  useEffect(() => () => setHighlight(null), [setHighlight]);

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const title = person
    ? `Stories mentioning ${person}`
    : on
      ? `On this day: ${dayLabel(on)}`
      : ongoing
        ? 'Developing events'
        : q
          ? `Search: ${q}`
          : kind === 'historical'
            ? 'Newly documented history'
            : kind === 'new'
              ? 'Recent events'
              : 'Explore';

  const mapNote = [
    filters.from !== null || filters.to !== null ? describeRange(filters.from, filters.to) : null,
    !urlCategories.length && filters.categories.length ? filters.categories.map((c) => CATEGORY_LABELS[c]).join(', ') : null,
  ].filter(Boolean);

  return (
    <Panel title={title} subtitle={ongoing ? 'Ongoing, or updated recently' : on ? 'Events that started or ended on this date' : undefined}>
      <div className="explore-head">
        <SearchBox initial={q ?? ''} onSearch={(text) => update({ q: text || undefined, sort: undefined })} />
        <SortControls sort={query.sort ?? 'occurred'} kind={kind} relevance={!!q} onChange={(next) => update({ sort: next.sort, kind: next.kind === 'all' ? undefined : next.kind })} />
        {urlCategories.length > 0 && (
          <p className="small muted">
            Only {urlCategories.map((c) => CATEGORY_LABELS[c]).join(', ')}.{' '}
            <button className="link-button small" onClick={() => update({ categories: undefined })}>Show all categories</button>
          </p>
        )}
        {hasFilters(filters) && mapNote.length > 0 && (
          <p className="small muted">
            Following the map's filters: {mapNote.join(' · ')}.{' '}
            <button className="link-button small" onClick={() => setFilters(NO_FILTERS)}>Clear</button>
          </p>
        )}
      </div>

      {list.isLoading && <p className="muted pad">Loading stories…</p>}
      {list.error && <p className="error-text pad">Couldn't load stories. Try again in a moment.</p>}
      {list.data && !stories.length && (
        <div className="empty">
          <p className="empty-title">No stories match yet.</p>
          <p className="muted">
            {hasFilters(filters) ? 'Try a wider time span or fewer categories, or ' : 'Try different words, or '}
            write the first story about it.
          </p>
        </div>
      )}
      {stories.length > 0 && (
        <div className="story-list">
          {stories.map((s) => <StoryRow key={s.id} story={s} />)}
          {list.hasNextPage && (
            <button className="button button-block" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  return (
    <form
      className="explore-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(text.trim());
      }}
    >
      <input
        type="search"
        value={text}
        maxLength={100}
        placeholder="Search stories, places, people"
        aria-label="Search stories"
        onChange={(e) => setText(e.target.value)}
      />
      <button className="button" type="submit">Search</button>
    </form>
  );
}
