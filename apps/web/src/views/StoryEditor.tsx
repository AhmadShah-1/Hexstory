import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  LIMITS,
  TRUST,
  createStorySchema,
  isDisplayCell,
  uncompact,
  type Category,
  type RichDoc,
  type StoryDetail,
  type WriteResult,
} from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useCreateStory, useEditStory, useSession, useStory } from '../api/queries';
import { CategoryPicker } from '../components/Categories';
import { ConnectionsField, type LinkDraft } from '../components/ConnectionsField';
import {
  DateInput,
  Field,
  SourcesInput,
  fieldErrors,
  fromDateDraft,
  sourcesFromDrafts,
  toDateDraft,
  todayDraft,
  type DateDraft,
  type SourceDraft,
} from '../components/DateInput';
import { LocationField } from '../components/LocationField';
import { Panel } from '../components/Panel';
import { PeopleField } from '../components/PeopleField';
import { RichEditor } from '../components/RichEditor';
import { SignInPrompt } from '../components/SignInPrompt';
import { NotFound } from './NotFound';
import { useToast } from '../components/Toast';
import { useMapState } from '../map/MapContext';

interface Draft {
  title: string;
  summary: string;
  content: RichDoc;
  start: DateDraft;
  end: DateDraft;
  timing: 'moment' | 'range' | 'ongoing';
  isApprox: boolean;
  placeName: string;
  /** Whether the wider area (map.selection) is part of the story. */
  areaOn: boolean;
  categories: Category[];
  sources: SourceDraft[];
  links: LinkDraft[];
  people: string[];
  editSummary: string;
}

function initialDraft(story: StoryDetail | undefined): Draft {
  if (!story) {
    return {
      title: '', summary: '', content: [], start: todayDraft(), end: todayDraft(), timing: 'moment', isApprox: false,
      placeName: '', areaOn: false, categories: [], sources: [{ title: '', url: '' }], links: [], people: [], editSummary: '',
    };
  }
  const r = story.revision;
  const titles = new Map(story.connections.filter((c) => c.direction === 'out').map((c) => [c.story.id, c.story.title]));
  return {
    title: r.title,
    // Older stories have no summary: the field starts empty and must be filled before saving.
    summary: r.summary ?? '',
    content: r.content,
    start: toDateDraft(r.start),
    end: toDateDraft(r.end),
    timing: r.isOngoing ? 'ongoing' : r.end ? 'range' : 'moment',
    isApprox: r.isApprox,
    placeName: r.location?.placeName ?? '',
    // One hexagon is just where the point falls; more means the writer marked a wider area.
    areaOn: story.cellCount > 1,
    categories: r.categories,
    sources: r.sources.map((s) => ({ title: s.title, url: s.url ?? '' })),
    links: r.links.map((l) => ({ ...l, title: titles.get(l.storyId) ?? 'A story you can’t see' })),
    people: r.people,
    editSummary: '',
  };
}

/** Creates a story (/new?cell=…) or edits one (/s/:id/edit). The map switches to picking mode meanwhile. */
export function StoryEditor() {
  const { id } = useParams();
  const story = useStory(id);
  const session = useSession();

  // Wait for a fresh copy: the draft and the version it is based on are fixed when the form opens, so a
  // cached, older version would make the save overwrite whatever changed since.
  if (id && (story.isLoading || (story.isFetching && !story.isFetchedAfterMount))) {
    return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  }
  if (id && !story.data) return <NotFound what="story" />;
  if (story.data && !story.data.can.edit && session.data?.user) {
    return (
      <Panel title="Edit story" back={{ label: 'Back to story', to: `/s/${story.data.id}` }}>
        <p className="pad">
          {story.data.revision.status === 'pending'
            ? "This story's first version is still waiting for a reviewer, so it can't be edited yet."
            : "You can't edit this story right now."}
        </p>
      </Panel>
    );
  }
  if (!session.data?.user) {
    return (
      <Panel title={id ? 'Edit story' : 'Write a story'}>
        <SignInPrompt reason="Sign in to write or edit stories. Reading is always open to everyone." />
      </Panel>
    );
  }
  return <EditorForm key={id ?? 'new'} story={story.data} />;
}

function EditorForm({ story: loaded }: { story: StoryDetail | undefined }) {
  // Fixed for the life of the form: a background refetch must not change the version the edit is based on.
  const [story] = useState(loaded);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const map = useMapState();
  const create = useCreateStory();
  const edit = useEditStory(story?.id ?? '');
  const mutation = story ? edit : create;
  const [draft, setDraft] = useState<Draft>(() => initialDraft(story));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const startCell = params.get('cell');
  const level = useSession().data?.user?.trustLevel ?? TRUST.NEW;
  const goLiveHint = !story
    ? level >= TRUST.MEMBER
      ? 'Your story goes live as soon as you publish it.'
      : 'New stories stay private until a reviewer approves them. You can keep editing yours meanwhile.'
    : !story.can.editGoesLive
      ? 'Your edit will be reviewed before it appears.'
      : story.status === 'unreviewed'
        ? "Your changes are saved straight away. The story stays private until a reviewer approves it."
        : 'Your changes go live as soon as you save them.';

  // Enter picking mode with the story's point and area, and leave it cleanly.
  const { setMode, setSelection, setPoint, setTool, focusCells, focusPoints } = map;
  useEffect(() => {
    setMode('select');
    setTool(story && story.cellCount > 1 ? 'area' : 'point');
    if (story) {
      const point = story.revision.location ?? story.point;
      setPoint({ lat: point.lat, lng: point.lng });
      setSelection(story.cellCount > 1 ? uncompact(story.revision.cells) : []);
      if (story.cellCount > 1) focusCells(story.revision.cells, { onlyIfHidden: true });
      else focusPoints([point], { onlyIfHidden: true });
    } else {
      setPoint(null);
      setSelection([]);
      // From a region's "Write a story here": look there, but let the writer place the pin.
      if (startCell && isDisplayCell(startCell)) focusCells([startCell], { onlyIfHidden: true });
    }
    return () => {
      setMode('browse');
      setTool('point');
      setPoint(null);
      setSelection([]);
    };
  }, [story, startCell, setMode, setTool, setPoint, setSelection, focusCells, focusPoints]);

  const [dirty, setDirty] = useState(false);
  const saved = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // Leaving inside the app (Cancel, ×, Escape, Back, a link) with unsaved changes asks first.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !saved.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Leave without saving? Your changes will be lost.')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const input = useMemo(() => ({
    title: draft.title,
    summary: draft.summary,
    content: draft.content,
    categories: draft.categories,
    location: map.point ? { lat: map.point.lat, lng: map.point.lng, placeName: draft.placeName.trim() || null } : undefined,
    cells: draft.areaOn ? [...map.selection] : [],
    start: fromDateDraft(draft.start),
    end: draft.timing === 'range' ? fromDateDraft(draft.end) : null,
    isOngoing: draft.timing === 'ongoing',
    isApprox: draft.isApprox,
    sources: sourcesFromDrafts(draft.sources),
    people: draft.people,
    links: draft.links.map(({ storyId, relation }) => ({ storyId, relation })),
  }), [draft, map.point, map.selection]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = createStorySchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    if (draft.areaOn && input.cells.length === 0) {
      setErrors({ cells: 'Pick the area on the map, or turn off the wider area.' });
      return;
    }
    setErrors({});
    const onSuccess = (res: WriteResult) => {
      saved.current = true;
      if (res.status === 'pending') {
        toast(story
          ? 'Thanks! Your edit will appear once a reviewer accepts it.'
          : 'Thanks! A reviewer will check your story before it is published. Until then only you and reviewers can see it.');
      } else if (res.storyStatus === 'unreviewed') {
        toast(story
          ? "Saved. Your story is still waiting for a reviewer's approval."
          : 'Saved. Your story will be published once a reviewer approves it. Until then only you and reviewers can see it.');
      } else {
        toast(story ? 'Saved' : 'Published. Thank you!');
      }
      // The author can always see their own story, even before it's public.
      navigate(`/s/${res.storyId}`);
    };
    if (story) {
      edit.mutate({ ...parsed.data, baseRevisionId: story.revision.id, editSummary: draft.editSummary || null }, { onSuccess });
    } else {
      create.mutate(parsed.data, { onSuccess });
    }
  };

  const summaryLength = draft.summary.trim().length;
  return (
    <Panel
      wide
      title={story ? 'Edit story' : 'Write a story'}
      back={{ label: 'Cancel', to: story ? `/s/${story.id}` : startCell ? `/h/${startCell}` : '/' }}
      footer={
        <div className="publish">
          <p className="muted small">
            By publishing you license your text under CC BY-SA 4.0 and confirm you have the right to share any image.
          </p>
          <p className="small publish-hint">{goLiveHint}</p>
          {mutation.error && <p className="error-text">{errorMessage(mutation.error)}</p>}
          {Object.keys(errors).length > 0 && <p className="error-text">Please fix the highlighted fields.</p>}
          <button className="button button-primary button-block" form="story-form" disabled={mutation.isPending}>
            {mutation.isPending ? 'Publishing…' : story ? 'Save changes' : 'Publish'}
          </button>
        </div>
      }
    >
      <form id="story-form" className="editor pad" onSubmit={submit} noValidate>
        <Field label="Title" error={errors.title}>
          <input value={draft.title} maxLength={LIMITS.titleMax} onChange={(e) => set('title', e.target.value)} placeholder="What happened?" />
        </Field>

        <Field
          label="Summary"
          error={errors.summary}
          hint={
            <span className="summary-hint">
              <span>One or two sentences: what happened, and why it matters. Readers see this first.</span>
              <span className={summaryLength > LIMITS.summaryMax || (summaryLength > 0 && summaryLength < LIMITS.summaryMin) ? 'error-text' : ''}>
                {summaryLength}/{LIMITS.summaryMax}
              </span>
            </span>
          }
        >
          <textarea rows={3} value={draft.summary} maxLength={LIMITS.summaryMax + 50} onChange={(e) => set('summary', e.target.value)} />
        </Field>

        <fieldset className="field">
          <legend>When</legend>
          <DateInput value={draft.start} onChange={(v) => set('start', v)} label="Start" />
          <div className="segmented" role="radiogroup" aria-label="Duration">
            {(['moment', 'range', 'ongoing'] as const).map((t) => (
              <label key={t}>
                <input type="radio" name="timing" checked={draft.timing === t} onChange={() => set('timing', t)} />
                {t === 'moment' ? 'One date' : t === 'range' ? 'Has an end' : 'Still ongoing'}
              </label>
            ))}
          </div>
          {draft.timing === 'range' && (
            <>
              <span className="muted small">Until</span>
              <DateInput value={draft.end} onChange={(v) => set('end', v)} label="End" />
            </>
          )}
          <label className="toggle">
            <input type="checkbox" checked={draft.isApprox} onChange={(e) => set('isApprox', e.target.checked)} />
            The date is approximate
          </label>
          {(errors.start || errors.end) && <p className="error-text">{errors.start ?? errors.end}</p>}
        </fieldset>

        <LocationField
          placeName={draft.placeName}
          onPlaceName={(v) => set('placeName', v)}
          error={errors.location}
          area={{ on: draft.areaOn, onToggle: (on) => set('areaOn', on), error: errors.cells }}
        />

        <fieldset className={`field ${errors.categories ? 'field-error' : ''}`}>
          <legend>What kind of event? <span className="muted small">(1 to {LIMITS.categoriesMax})</span></legend>
          <CategoryPicker label="Categories" value={draft.categories} max={LIMITS.categoriesMax} onChange={(v) => set('categories', v)} />
          {errors.categories && <p className="error-text">{errors.categories}</p>}
        </fieldset>

        <div className={`field ${errors.content ? 'field-error' : ''}`}>
          <span className="field-label">The full account</span>
          <RichEditor initial={draft.content} onChange={(doc) => set('content', doc)} />
          <span className="muted small">Opinions are welcome. Say what you know and how you know it.</span>
          {errors.content && <span className="error-text">{errors.content}</span>}
        </div>

        <fieldset className="field">
          <legend>Sources</legend>
          <p className="muted small">At least one. Readers see how many sources a story lists.</p>
          <SourcesInput value={draft.sources} onChange={(v) => set('sources', v)} />
          {errors.sources && <p className="error-text">{errors.sources}</p>}
        </fieldset>

        <ConnectionsField value={draft.links} onChange={(v) => set('links', v)} selfId={story?.id} error={errors.links} />
        <PeopleField value={draft.people} onChange={(v) => set('people', v)} error={errors.people} />

        {story && (
          <Field label="What did you change?" hint="Optional, helps reviewers.">
            <input value={draft.editSummary} maxLength={LIMITS.editSummaryMax} onChange={(e) => set('editSummary', e.target.value)} />
          </Field>
        )}
      </form>
    </Panel>
  );
}
