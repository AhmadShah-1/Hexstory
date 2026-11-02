import { STORY_SORT_LABELS, type StoryKind, type StorySort } from '@hexstory/shared';

const KIND_LABELS: Record<StoryKind, string> = {
  all: 'All stories',
  new: 'Events as they happened',
  historical: 'Newly documented history',
};

/**
 * How a list is ordered and which kind of stories it shows. `relevance` is offered only where there is
 * something to be relevant to (a search, a region).
 */
export function SortControls({
  sort,
  kind,
  onChange,
  relevance = false,
}: {
  sort: StorySort;
  kind: StoryKind;
  onChange: (next: { sort: StorySort; kind: StoryKind }) => void;
  relevance?: boolean;
}) {
  const sorts = (Object.keys(STORY_SORT_LABELS) as StorySort[]).filter((s) => relevance || s !== 'relevance');
  return (
    <div className="sort-controls">
      <label>
        <span className="visually-hidden">Order by</span>
        <select value={sort} onChange={(e) => onChange({ sort: e.target.value as StorySort, kind })}>
          {sorts.map((s) => (
            <option key={s} value={s}>{STORY_SORT_LABELS[s]}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="visually-hidden">Show</span>
        <select value={kind} onChange={(e) => onChange({ sort, kind: e.target.value as StoryKind })}>
          {(Object.keys(KIND_LABELS) as StoryKind[]).map((k) => (
            <option key={k} value={k}>{KIND_LABELS[k]}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
