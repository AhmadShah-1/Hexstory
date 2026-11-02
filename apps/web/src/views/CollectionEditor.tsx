import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import {
  LIMITS,
  TRUST,
  collectionSchema,
  compactDisplay,
  formatEventDate,
  toBaseCells,
  type Category,
  type CollectionDetail,
  type CollectionKind,
  type DateParts,
} from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useCollection, useSaveCollection, useSession } from '../api/queries';
import { CategoryPicker } from '../components/Categories';
import { Panel } from '../components/Panel';
import { SignInPrompt } from '../components/SignInPrompt';
import { StoryPicker } from '../components/StoryPicker';
import { useToast } from '../components/Toast';
import { areaKm2 } from '../lib/format';
import { useMapState } from '../map/MapContext';
import { NotFound } from './NotFound';

/** A hand-picked story as the editor shows it. */
interface Item {
  id: string;
  title: string;
  when: string;
  note: string;
}

interface Draft {
  title: string;
  description: string;
  kind: CollectionKind;
  categories: Category[];
  fromYear: string;
  toYear: string;
  items: Item[];
}

const whenOf = (s: { start: DateParts; end: DateParts | null; isOngoing: boolean; isApprox: boolean }) => formatEventDate(s);

function initialDraft(c: CollectionDetail | undefined): Draft {
  if (!c) return { title: '', description: '', kind: 'place', categories: [], fromYear: '', toYear: '', items: [] };
  return {
    title: c.title,
    description: c.description,
    kind: c.kind,
    categories: c.categories,
    fromYear: c.fromYear == null ? '' : String(c.fromYear),
    toYear: c.toYear == null ? '' : String(c.toYear),
    items: c.items.map(({ story, note }) => ({ id: story.id, title: story.title, when: whenOf(story), note: note ?? '' })),
  };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));
/** "" → null, "-500" → -500; anything else becomes NaN so validation reports it. */
const yearValue = (v: string) => (v.trim() === '' ? null : /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);

/** Starts a collection (/collections/new) or changes one (/c/:id/edit). The map picks the area meanwhile. */
export function CollectionEditor() {
  const { id } = useParams();
  const collection = useCollection(id);
  const session = useSession();
  const user = session.data?.user;

  // Wait for a fresh copy, so saving never replaces newer contents with an older cached version.
  if (id && (collection.isLoading || (collection.isFetching && !collection.isFetchedAfterMount))) {
    return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  }
  if (id && !collection.data) return <NotFound what="collection" />;
  if (session.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  if (!user) {
    return (
      <Panel title={id ? 'Edit collection' : 'Start a collection'}>
        <SignInPrompt reason="Sign in to start or edit collections. Reading them is open to everyone." />
      </Panel>
    );
  }
  if (collection.data && !collection.data.can.edit) {
    return (
      <Panel title="Edit collection" back={{ label: 'Back to collection', to: `/c/${collection.data.id}` }}>
        <p className="pad">Only the person who started this collection and reviewers can change it.</p>
      </Panel>
    );
  }
  if (!id && user.trustLevel < TRUST.MEMBER) {
    return (
      <Panel title="Start a collection" back={{ label: 'Collections', to: '/collections' }}>
        <p className="pad">
          Collections can be started by Members. You become a Member automatically as your stories and corrections are
          accepted; <Link to="/me">your account page</Link> shows how close you are.
        </p>
      </Panel>
    );
  }
  return <CollectionForm key={id ?? 'new'} collection={collection.data} />;
}

function CollectionForm({ collection: loaded }: { collection: CollectionDetail | undefined }) {
  // Fixed for the life of the form: a background refetch must not reset what's being edited.
  const [collection] = useState(loaded);
  const navigate = useNavigate();
  const toast = useToast();
  const map = useMapState();
  const save = useSaveCollection(collection?.id);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(collection));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState(false);
  const saved = useRef(false);

  // Pick the area on the map: clicks add or remove hexagons while the editor is open.
  const initialCells = useMemo(() => new Set(collection ? toBaseCells(collection.cells) : []), [collection]);
  const { setMode, setTool, setSelection, setSelectionLimit, focusCells } = map;
  useEffect(() => {
    setMode('select');
    setTool('area');
    // Places such as "How European borders changed" can be continent-sized, larger than any one story.
    setSelectionLimit(LIMITS.collectionCellsMax);
    setSelection(initialCells);
    if (collection?.cells.length) focusCells(collection.cells, { onlyIfHidden: true });
    return () => {
      setMode('browse');
      setTool('point');
      setSelection([]);
      setSelectionLimit(LIMITS.cellsMax);
    };
  }, [initialCells, collection, setMode, setTool, setSelection, setSelectionLimit, focusCells]);

  const areaChanged = useMemo(() => !sameSet(map.selection, initialCells), [map.selection, initialCells]);
  const dirty = edited || areaChanged;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !saved.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Leave without saving? Your changes will be lost.')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setEdited(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const moveItem = (from: number, to: number) => {
    const items = [...draft.items];
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item!);
    set('items', items);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const yearErrors = Object.fromEntries(
      (['fromYear', 'toYear'] as const).filter((k) => Number.isNaN(yearValue(draft[k]))).map((k) => [k, 'Enter a whole year, e.g. 1848 or -500']),
    );
    if (Object.keys(yearErrors).length) return setErrors(yearErrors);
    const parsed = collectionSchema.safeParse({
      title: draft.title,
      description: draft.description,
      kind: draft.kind,
      // The map works in base cells; store the smallest equivalent set of display hexagons.
      cells: map.selection.size ? compactDisplay([...map.selection]) : [],
      categories: draft.categories,
      fromYear: yearValue(draft.fromYear),
      toYear: yearValue(draft.toYear),
      items: draft.items.map((i) => ({ storyId: i.id, note: i.note })),
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? 'form')] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: (res) => {
        saved.current = true;
        toast(collection ? 'Saved' : 'Collection started. Thank you!');
        navigate(`/c/${res.id}`);
      },
    });
  };

  const area = map.selection.size;
  return (
    <Panel
      wide
      title={collection ? 'Edit collection' : 'Start a collection'}
      back={{ label: 'Cancel', to: collection ? `/c/${collection.id}` : '/collections' }}
      footer={
        <div className="publish">
          <p className="muted small">Collections are public and shared under CC BY-SA 4.0. Reviewers can change or hide them.</p>
          {save.error && <p className="error-text">{errorMessage(save.error)}</p>}
          {Object.keys(errors).length > 0 && <p className="error-text">Please fix the highlighted fields.</p>}
          <button className="button button-primary button-block" form="collection-form" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : collection ? 'Save changes' : 'Start collection'}
          </button>
        </div>
      }
    >
      <form id="collection-form" className="editor pad" onSubmit={submit} noValidate>
        <label className={`field ${errors.title ? 'field-error' : ''}`}>
          <span>Title</span>
          <input
            value={draft.title}
            maxLength={LIMITS.collectionTitleMax}
            onChange={(e) => set('title', e.target.value)}
            placeholder={draft.kind === 'place' ? 'The history of Manhattan' : 'The Arab Spring'}
          />
          {errors.title && <span className="error-text">{errors.title}</span>}
        </label>

        <label className={`field ${errors.description ? 'field-error' : ''}`}>
          <span>What is it about?</span>
          <textarea rows={4} value={draft.description} maxLength={LIMITS.collectionDescriptionMax} onChange={(e) => set('description', e.target.value)} />
          {errors.description && <span className="error-text">{errors.description}</span>}
        </label>

        <fieldset className="field">
          <legend>Kind</legend>
          <div className="segmented" role="radiogroup" aria-label="Kind">
            {(['place', 'theme'] as const).map((k) => (
              <label key={k}>
                <input type="radio" name="kind" checked={draft.kind === k} onChange={() => set('kind', k)} />
                {k === 'place' ? 'A place' : 'A theme'}
              </label>
            ))}
          </div>
          <span className="muted small">
            {draft.kind === 'place'
              ? 'Everything that happened in an area, gathered automatically, plus any stories you pick.'
              : 'A narrative across places: pick the stories, and optionally gather more by category, years or area.'}
          </span>
        </fieldset>

        <fieldset className="field">
          <legend>{draft.kind === 'place' ? 'Area' : 'Only stories in an area (optional)'}</legend>
          <div className="where">
            <strong>{area === 0 ? 'Nothing selected yet' : `About ${areaKm2(area)} selected`}</strong>
            <p className="muted small">
              Click hexagons on the map to add or remove them. Zoom out to pick bigger hexagons; areas can be up to about{' '}
              {areaKm2(LIMITS.collectionCellsMax)}.
            </p>
            {area > 0 && (
              <div className="row">
                <button type="button" className="link-button" onClick={() => map.focusCells(compactDisplay([...map.selection]))}>Show on map</button>
                <button type="button" className="link-button" onClick={() => map.setSelection([])}>Clear</button>
              </div>
            )}
          </div>
          {errors.cells && <p className="error-text">{errors.cells}</p>}
        </fieldset>

        <fieldset className="field">
          <legend>Only some kinds of events (optional)</legend>
          <CategoryPicker label="Categories" value={draft.categories} onChange={(c) => set('categories', c)} />
          <span className="muted small">None selected: every kind.</span>
        </fieldset>

        <fieldset className={`field ${errors.fromYear || errors.toYear ? 'field-error' : ''}`}>
          <legend>Only these years (optional)</legend>
          <div className="row collection-years">
            <label>
              <span className="visually-hidden">From year</span>
              <input inputMode="numeric" placeholder="From" value={draft.fromYear} onChange={(e) => set('fromYear', e.target.value.replace(/[^\d-]/g, '').slice(0, 7))} />
            </label>
            <span className="muted">to</span>
            <label>
              <span className="visually-hidden">To year</span>
              <input inputMode="numeric" placeholder="To" value={draft.toYear} onChange={(e) => set('toYear', e.target.value.replace(/[^\d-]/g, '').slice(0, 7))} />
            </label>
          </div>
          <span className="muted small">Use a minus sign for years BCE, e.g. -500.</span>
          {(errors.fromYear || errors.toYear) && <p className="error-text">{errors.fromYear ?? errors.toYear}</p>}
        </fieldset>

        <fieldset className={`field ${errors.items ? 'field-error' : ''}`}>
          <legend>Stories picked by hand</legend>
          <p className="muted small">They are shown first, in this order, with your note. Only published stories can be added.</p>
          {draft.items.length < LIMITS.collectionItemsMax && (
            <StoryPicker
              exclude={draft.items.map((i) => i.id)}
              onPick={(s) => set('items', [...draft.items, { id: s.id, title: s.title, when: whenOf(s), note: '' }])}
            />
          )}
          <ol className="collection-items-editor">
            {draft.items.map((item, i) => (
              <li key={item.id}>
                <div className="collection-item-head">
                  <div>
                    <div className="story-picker-title">{item.title}</div>
                    <div className="muted small">{item.when}</div>
                  </div>
                  <div className="row">
                    <button type="button" className="icon-button" aria-label={`Move ${item.title} up`} disabled={i === 0} onClick={() => moveItem(i, i - 1)}>↑</button>
                    <button type="button" className="icon-button" aria-label={`Move ${item.title} down`} disabled={i === draft.items.length - 1} onClick={() => moveItem(i, i + 1)}>↓</button>
                    <button type="button" className="icon-button" aria-label={`Remove ${item.title}`} onClick={() => set('items', draft.items.filter((_, j) => j !== i))}>×</button>
                  </div>
                </div>
                <input
                  value={item.note}
                  maxLength={LIMITS.collectionNoteMax}
                  placeholder="Note (optional): why it belongs here"
                  aria-label={`Note for ${item.title}`}
                  onChange={(e) => set('items', draft.items.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                />
              </li>
            ))}
          </ol>
          {errors.items && <p className="error-text">{errors.items}</p>}
        </fieldset>
      </form>
    </Panel>
  );
}
