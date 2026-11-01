import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  LIMITS,
  TRUST,
  createStorySchema,
  isDisplayCell,
  toBaseCells,
  uncompact,
  type CreateStoryInput,
  type DateParts,
  type RichDoc,
  type StoryDetail,
  type WriteResult,
} from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useCreateStory, useEditStory, useSession, useStory } from '../api/queries';
import { Panel } from '../components/Panel';
import { RichEditor } from '../components/RichEditor';
import { SignInPrompt } from '../components/SignInPrompt';
import { useToast } from '../components/Toast';
import { areaKm2 } from '../lib/format';
import { useMapState } from '../map/MapContext';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface DateDraft { year: string; era: 'CE' | 'BCE'; month: string; day: string }
interface Draft {
  title: string;
  content: RichDoc;
  start: DateDraft;
  end: DateDraft;
  timing: 'moment' | 'range' | 'ongoing';
  isApprox: boolean;
  sources: { title: string; url: string }[];
  editSummary: string;
}

/** Most stories are about recent events, so dates start at today. */
function today(): DateDraft {
  const now = new Date();
  return { year: String(now.getFullYear()), era: 'CE', month: String(now.getMonth() + 1), day: String(now.getDate()) };
}

function toDateDraft(d: DateParts | null): DateDraft {
  if (!d) return today();
  return { year: String(Math.abs(d.year)), era: d.year < 0 ? 'BCE' : 'CE', month: d.month ? String(d.month) : '', day: d.day ? String(d.day) : '' };
}

function fromDateDraft(d: DateDraft): DateParts {
  // An empty year becomes NaN so validation says "Enter the year" rather than "There is no year 0".
  const year = d.year ? Number(d.year) * (d.era === 'BCE' ? -1 : 1) : NaN;
  return { year, month: d.month ? Number(d.month) : null, day: d.month && d.day ? Number(d.day) : null };
}

function initialDraft(story: StoryDetail | undefined): Draft {
  if (!story) {
    return {
      title: '', content: [], start: today(), end: today(), timing: 'moment', isApprox: false,
      sources: [{ title: '', url: '' }], editSummary: '',
    };
  }
  const r = story.revision;
  return {
    title: r.title,
    content: r.content,
    start: toDateDraft(r.start),
    end: toDateDraft(r.end),
    timing: r.isOngoing ? 'ongoing' : r.end ? 'range' : 'moment',
    isApprox: r.isApprox,
    sources: r.sources.map((s) => ({ title: s.title, url: s.url ?? '' })),
    editSummary: '',
  };
}

/** Creates a story (/new?cell=…) or edits one (/s/:id/edit). The map switches to region-picking mode meanwhile. */
export function StoryEditor() {
  const { id } = useParams();
  const story = useStory(id);
  const session = useSession();

  if (id && story.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  if (!session.data?.user) {
    return (
      <Panel title={id ? 'Edit story' : 'Write a story'}>
        <SignInPrompt reason="Sign in to write or edit stories. Reading is always open to everyone." />
      </Panel>
    );
  }
  return <EditorForm key={id ?? 'new'} story={story.data} />;
}

function EditorForm({ story }: { story: StoryDetail | undefined }) {
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

  // Enter region-picking mode with the starting selection, and leave it cleanly.
  const { setMode, setSelection, focusCells } = map;
  useEffect(() => {
    const initial = story ? uncompact(story.revision.cells) : startCell && isDisplayCell(startCell) ? toBaseCells([startCell]) : [];
    setMode('select');
    setSelection(initial);
    const focus = story ? story.revision.cells : startCell && isDisplayCell(startCell) ? [startCell] : [];
    if (focus.length) focusCells(focus, { onlyIfHidden: true });
    return () => {
      setMode('browse');
      setSelection([]);
    };
  }, [story, startCell, setMode, setSelection, focusCells]);

  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const regionCount = map.selection.size;

  const input = useMemo((): CreateStoryInput => ({
    title: draft.title,
    content: draft.content,
    cells: [...map.selection],
    start: fromDateDraft(draft.start),
    end: draft.timing === 'range' ? fromDateDraft(draft.end) : null,
    isOngoing: draft.timing === 'ongoing',
    isApprox: draft.isApprox,
    sources: draft.sources.filter((s) => s.title.trim() || s.url.trim()).map((s) => ({ title: s.title.trim() || s.url.trim(), url: s.url.trim() || null })),
  }), [draft, map.selection]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = createStorySchema.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? 'form')] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    const onSuccess = (res: WriteResult) => {
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

        <fieldset className="field">
          <legend>When</legend>
          <DateInput value={draft.start} onChange={(v) => set('start', v)} />
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
              <DateInput value={draft.end} onChange={(v) => set('end', v)} />
            </>
          )}
          <label className="toggle">
            <input type="checkbox" checked={draft.isApprox} onChange={(e) => set('isApprox', e.target.checked)} />
            The date is approximate
          </label>
          {(errors.start || errors.end) && <p className="error-text">{errors.start ?? errors.end}</p>}
        </fieldset>

        <fieldset className="field">
          <legend>Where</legend>
          <div className="where">
            <strong>{regionCount === 0 ? 'Nothing selected yet' : `About ${areaKm2(regionCount)} selected`}</strong>
            <p className="muted small">
              Click hexagons on the map to add or remove them. Zoomed out, one click covers a wide area; zoom in for precision.
            </p>
            <div className="row">
              {regionCount > 0 && (
                <>
                  <button type="button" className="link-button" onClick={() => map.focusCells([...map.selection])}>Show on map</button>
                  <button type="button" className="link-button" onClick={() => map.setSelection([])}>Clear</button>
                </>
              )}
            </div>
          </div>
          {errors.cells && <p className="error-text">{errors.cells}</p>}
        </fieldset>

        <div className={`field ${errors.content ? 'field-error' : ''}`}>
          <span className="field-label">The story</span>
          <RichEditor initial={draft.content} onChange={(doc) => set('content', doc)} />
          <span className="muted small">Opinions are welcome. Say what you know and how you know it.</span>
          {errors.content && <span className="error-text">{errors.content}</span>}
        </div>

        <fieldset className="field">
          <legend>Sources</legend>
          <p className="muted small">At least one. Readers see how many sources a story lists.</p>
          {draft.sources.map((s, i) => (
            <div className="source-input" key={i}>
              <input
                value={s.title}
                placeholder="Title (book, article, eyewitness…)"
                maxLength={LIMITS.sourceTitleMax}
                onChange={(e) => set('sources', draft.sources.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              />
              <input
                value={s.url}
                placeholder="Link (optional)"
                inputMode="url"
                maxLength={LIMITS.sourceUrlMax}
                onChange={(e) => set('sources', draft.sources.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
              />
              {draft.sources.length > 1 && (
                <button type="button" className="icon-button" aria-label="Remove source" onClick={() => set('sources', draft.sources.filter((_, j) => j !== i))}>
                  ×
                </button>
              )}
            </div>
          ))}
          {draft.sources.length < LIMITS.sourcesMax && (
            <button type="button" className="link-button" onClick={() => set('sources', [...draft.sources, { title: '', url: '' }])}>
              + Add another source
            </button>
          )}
          {errors.sources && <p className="error-text">{errors.sources}</p>}
        </fieldset>

        {story && (
          <Field label="What did you change?" hint="Optional, helps reviewers.">
            <input value={draft.editSummary} maxLength={LIMITS.editSummaryMax} onChange={(e) => set('editSummary', e.target.value)} />
          </Field>
        )}
      </form>
    </Panel>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={`field ${error ? 'field-error' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
      {error && <span className="error-text">{error}</span>}
    </label>
  );
}

function DateInput({ value, onChange }: { value: DateDraft; onChange: (v: DateDraft) => void }) {
  const set = (patch: Partial<DateDraft>) => onChange({ ...value, ...patch });
  return (
    <div className={`date-input ${value.era === 'BCE' ? 'date-input-era' : ''}`}>
      <input
        aria-label="Year"
        placeholder="Year"
        inputMode="numeric"
        value={value.year}
        onChange={(e) => set({ year: e.target.value.replace(/\D/g, '').slice(0, 5) })}
      />
      {/* BCE is supported but rare; the era picker only appears for dates that already use it. */}
      {value.era === 'BCE' && (
        <select aria-label="Era" value={value.era} onChange={(e) => set({ era: e.target.value as 'CE' | 'BCE' })}>
          <option value="CE">CE</option>
          <option value="BCE">BCE</option>
        </select>
      )}
      <select aria-label="Month" value={value.month} onChange={(e) => set({ month: e.target.value, day: e.target.value ? value.day : '' })}>
        <option value="">Month</option>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        aria-label="Day"
        placeholder="Day"
        inputMode="numeric"
        disabled={!value.month}
        value={value.day}
        onChange={(e) => set({ day: e.target.value.replace(/\D/g, '').slice(0, 2) })}
      />
    </div>
  );
}
