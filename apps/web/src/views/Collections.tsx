import { Link, useSearchParams } from 'react-router';
import { TRUST, type CollectionKind, type CollectionSummary } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useCollections, useSession } from '../api/queries';
import { Panel } from '../components/Panel';

const TABS: { id: CollectionKind | 'all'; label: string }[] = [
  { id: 'place', label: 'Places' },
  { id: 'theme', label: 'Themes' },
  { id: 'all', label: 'All' },
];

/** Excerpt of a description: whole words, about two lines. */
export const excerpt = (text: string, max = 160) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`);

/** Collections (/collections): narratives grouping stories by place or by theme. Featured ones come first. */
export function Collections() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get('kind'))?.id ?? 'all';
  const query = useCollections(tab === 'all' ? undefined : tab);
  const user = useSession().data?.user;
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Panel
      title="Collections"
      subtitle="Stories gathered into places and narratives"
      footer={
        user && user.trustLevel >= TRUST.MEMBER ? (
          <Link className="button button-primary button-block" to="/collections/new">Start a collection</Link>
        ) : (
          <p className="muted small">Members can start collections. You become a Member as your contributions are accepted.</p>
        )
      }
    >
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === 'all' ? {} : { kind: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {query.isLoading && <p className="muted pad">Loading collections…</p>}
      {query.error && <p className="error-text pad">{errorMessage(query.error)}</p>}
      {query.data && !items.length && (
        <div className="empty">
          <p className="empty-title">No collections here yet.</p>
          <p className="muted">
            {tab === 'place'
              ? 'A place collection gathers everything that happened in an area, like "The history of Manhattan".'
              : 'A theme collection tells a story across places, like "The Arab Spring".'}
          </p>
        </div>
      )}
      <div className="collection-list pad">
        {items.map((c) => (
          <CollectionCard key={c.id} collection={c} />
        ))}
        {query.hasNextPage && (
          <button className="button button-block" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        )}
      </div>
    </Panel>
  );
}

export function CollectionCard({ collection: c }: { collection: CollectionSummary }) {
  return (
    <Link to={`/c/${c.id}`} className="collection-card">
      <div className="collection-card-head">
        <span className={`collection-kind collection-kind-${c.kind}`}>{c.kind === 'place' ? 'Place' : 'Theme'}</span>
        {c.featured && <span className="chip chip-quiet">Featured</span>}
      </div>
      <div className="collection-card-title">{c.title}</div>
      <p className="collection-card-text">{excerpt(c.description)}</p>
      {/* A plain count, not a ranking: collections are listed featured first, then by latest change. */}
      <span className="muted small">{c.storyCount === 1 ? '1 story' : `${c.storyCount} stories`}</span>
    </Link>
  );
}
