import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { LIMITS, createDevelopmentSchema } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useAddDevelopment, useSession, useStory } from '../api/queries';
import { DateInput, Field, SourcesInput, fieldErrors, fromDateDraft, sourcesFromDrafts, todayDraft, type DateDraft, type SourceDraft } from '../components/DateInput';
import { LocationField } from '../components/LocationField';
import { Panel } from '../components/Panel';
import { SignInPrompt } from '../components/SignInPrompt';
import { useToast } from '../components/Toast';
import { useMapState } from '../map/MapContext';
import { LoadFailed, NotFound } from './NotFound';

/**
 * Adds a dated development to an event's timeline (/s/:id/develop): a new turn in a war, a protest or a
 * political crisis, with its own date, place and sources, instead of a separate disconnected story.
 */
export function DevelopmentEditor() {
  const { id = '' } = useParams();
  const story = useStory(id);
  const session = useSession();

  if (story.isLoading) return <Panel title="Loading…"><p className="muted pad">Loading…</p></Panel>;
  if (!story.data) return story.error ? <LoadFailed error={story.error} what="story" retry={() => story.refetch()} /> : <NotFound what="story" />;
  if (!session.data?.user) {
    return (
      <Panel title="Add a development" back={{ label: 'Back to story', to: `/s/${id}` }}>
        <SignInPrompt reason="Sign in to add developments to an event's timeline. Reading is always open to everyone." />
      </Panel>
    );
  }
  if (!story.data.can.addDevelopment) {
    return (
      <Panel title="Add a development" back={{ label: 'Back to story', to: `/s/${id}` }}>
        <p className="pad">Developments can't be added to this story right now.</p>
      </Panel>
    );
  }
  return <DevelopmentForm storyId={id} storyTitle={story.data.revision.title} goesLive={story.data.can.editGoesLive} />;
}

function DevelopmentForm({ storyId, storyTitle, goesLive }: { storyId: string; storyTitle: string; goesLive: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const add = useAddDevelopment(storyId);
  const [date, setDate] = useState<DateDraft>(todayDraft);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [placeName, setPlaceName] = useState('');
  const [sources, setSources] = useState<SourceDraft[]>([{ title: '', url: '' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The place is optional and a single point; the map drops a pin where you click.
  const map = useMapState();
  const { setMode, setTool, setPoint, setSelection } = map;
  useEffect(() => {
    setMode('select');
    setTool('point');
    setPoint(null);
    return () => {
      setMode('browse');
      setTool('point');
      setPoint(null);
      setSelection([]);
    };
  }, [setMode, setTool, setPoint, setSelection]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = createDevelopmentSchema.safeParse({
      date: fromDateDraft(date),
      title,
      body,
      location: map.point ? { ...map.point, placeName: placeName.trim() || null } : null,
      sources: sourcesFromDrafts(sources),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    add.mutate(parsed.data, {
      onSuccess: (res) => {
        toast(res.status === 'live' ? 'Added to the timeline' : 'Thanks! A reviewer will check it before it appears.');
        navigate(`/s/${storyId}`);
      },
    });
  };

  return (
    <Panel
      wide
      title="Add a development"
      subtitle={storyTitle}
      back={{ label: 'Cancel', to: `/s/${storyId}` }}
      footer={
        <div className="publish">
          <p className="small publish-hint">
            {goesLive ? 'It appears on the timeline as soon as you add it.' : 'A reviewer will check it before it appears.'}
          </p>
          {add.error && <p className="error-text">{errorMessage(add.error)}</p>}
          <button className="button button-primary button-block" form="development-form" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add to the timeline'}
          </button>
        </div>
      }
    >
      <form id="development-form" className="editor pad" onSubmit={submit} noValidate>
        <p className="muted small development-intro">
          For a new turn in this event: a battle, a ruling, a resignation, a new wave of protest. Each development
          keeps its own date, place and sources on the story's timeline.
        </p>
        <fieldset className="field">
          <legend>When</legend>
          <DateInput value={date} onChange={setDate} />
          {errors.date && <p className="error-text">{errors.date}</p>}
        </fieldset>
        <Field label="Headline" error={errors.title}>
          <input value={title} maxLength={LIMITS.developmentTitleMax} placeholder="What happened?" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Details (optional)" error={errors.body} hint={`${body.trim().length}/${LIMITS.developmentBodyMax}`}>
          <textarea rows={4} value={body} maxLength={LIMITS.developmentBodyMax} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <LocationField optional placeName={placeName} onPlaceName={setPlaceName} error={errors.location} />
        <fieldset className="field">
          <legend>Sources</legend>
          <SourcesInput value={sources} onChange={setSources} />
          {errors.sources && <p className="error-text">{errors.sources}</p>}
        </fieldset>
      </form>
    </Panel>
  );
}
