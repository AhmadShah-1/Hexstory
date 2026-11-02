import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { CollectionSummary, StorySummary } from '@hexstory/shared';
import { useDiscover } from '../api/queries';
import { Panel } from '../components/Panel';
import { StoryRow } from '../components/StoryRow';
import { OPEN_HOME_EVENT, TourInvite } from '../components/Tour';
import { today, useRandomStory } from '../lib/discover';
import { useMapState } from '../map/MapContext';

const COLLAPSED_KEY = 'hexstory:home-collapsed';
/** Below this many published stories the home page invites people to write rather than to browse. */
const YOUNG_SITE = 8;

function readCollapsed() {
  try {
    return sessionStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
function saveCollapsed(value: boolean) {
  try {
    if (value) sessionStorage.setItem(COLLAPSED_KEY, '1');
    else sessionStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

/**
 * The home page: guided discovery beside the map, which stays the centrepiece and fully interactive.
 * Quick ways in (surprise, random, near me, on this day), then featured, developing, newly documented
 * and recent stories, and collections. Empty sections are left out; a young site invites writing
 * instead of looking deserted. Closing it leaves just the map, with a "Discover" button to come back
 * (remembered for this visit only).
 */
export function Home() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const { setHighlight, setStoryCells, setStoryPoint, setMarkers } = useMapState();

  // Whatever was being read before (a story's footprint, a collection's highlight) no longer applies.
  useEffect(() => {
    setHighlight(null);
    setStoryCells([]);
    setStoryPoint(null);
    setMarkers([]);
  }, [setHighlight, setStoryCells, setStoryPoint, setMarkers]);

  const collapse = (value: boolean) => {
    setCollapsed(value);
    saveCollapsed(value);
  };

  // The tour walks through this panel, so it reopens it if it was collapsed.
  useEffect(() => {
    const open = () => {
      setCollapsed(false);
      saveCollapsed(false);
    };
    window.addEventListener(OPEN_HOME_EVENT, open);
    return () => window.removeEventListener(OPEN_HOME_EVENT, open);
  }, []);

  if (collapsed) {
    return (
      <button className="discover-pill button button-floating" onClick={() => collapse(false)}>
        Discover stories
      </button>
    );
  }
  return (
    <Panel title="Discover" subtitle="Every place has a story" onClose={() => collapse(true)}>
      <HomeContent />
    </Panel>
  );
}

function HomeContent() {
  const discover = useDiscover();
  const random = useRandomStory();
  const day = today();
  const data = discover.data;

  return (
    <div className="home">
      <TourInvite />
      <div className="discover-actions" role="group" aria-label="Ways to start">
        <button className="discover-action" disabled={random.busy} onClick={() => random.go('surprise')}>
          <span className="discover-action-title">Surprise me</span>
          <span className="muted small">A well-sourced story picked for you</span>
        </button>
        <button className="discover-action" disabled={random.busy} onClick={() => random.go('any')}>
          <span className="discover-action-title">Random event</span>
          <span className="muted small">Anything, anywhere, any time</span>
        </button>
        <Link className="discover-action" to="/near">
          <span className="discover-action-title">History near me</span>
          <span className="muted small">What happened around you</span>
        </Link>
        <Link className="discover-action" to={`/explore?on=${day.param}`}>
          <span className="discover-action-title">On this day</span>
          <span className="muted small">{day.label} through history</span>
        </Link>
      </div>

      {discover.isLoading && <p className="muted pad">Loading stories…</p>}
      {discover.error && <p className="error-text pad">Couldn't load stories. Try again in a moment.</p>}

      {data && data.total < YOUNG_SITE && (
        <div className="young-site">
          <p className="young-site-title">Hexstory is just getting started.</p>
          <p className="muted small">
            Every story added now becomes part of a shared, sourced map of history. Know what happened in your
            town, or in a place you love? Write it down with a source, and connect it to the events around it.
          </p>
          <div className="row">
            <Link className="button button-primary" to="/new">Write a story</Link>
            <Link className="button" to="/about">How it works</Link>
          </div>
        </div>
      )}

      {data && (
        <>
          <StorySection title="Featured" stories={data.featured} />
          <StorySection title="Developing now" stories={data.developing} more={{ to: '/explore?ongoing=1', label: 'All developing events' }} />
          <StorySection
            title="Newly documented history"
            note="Older events, recently added to the record"
            stories={data.discoveries}
            more={{ to: '/explore?kind=historical&sort=published', label: 'More newly documented history' }}
          />
          <StorySection
            title="Recent events"
            note="Written about as they happened"
            stories={data.recent}
            more={{ to: '/explore?kind=new&sort=published', label: 'More recent events' }}
          />
          <StorySection title={`On this day, ${day.label}`} stories={data.onThisDay} more={{ to: `/explore?on=${day.param}`, label: 'Everything on this day' }} />
          <CollectionSection collections={data.collections} />
          {data.total >= YOUNG_SITE && (
            <p className="home-foot muted small">
              Or wander the map: every dot is a story, and any hexagon opens what happened there. Use the filters below the map
              to travel through time.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, note, more, children }: { title: string; note?: string; more?: { to: string; label: string }; children: ReactNode }) {
  return (
    <section className="home-section">
      <header className="home-section-head">
        <h2 className="section-label">{title}</h2>
        {note && <span className="muted small">{note}</span>}
      </header>
      {children}
      {more && <Link className="home-more small" to={more.to}>{more.label} →</Link>}
    </section>
  );
}

function StorySection({ title, note, stories, more }: { title: string; note?: string; stories: StorySummary[]; more?: { to: string; label: string } }) {
  if (!stories.length) return null;
  return (
    <Section title={title} note={note} more={more}>
      <div className="story-list">
        {stories.map((s) => <StoryRow key={s.id} story={s} />)}
      </div>
    </Section>
  );
}

function CollectionSection({ collections }: { collections: CollectionSummary[] }) {
  if (!collections.length) return null;
  return (
    <Section title="Places and collections to explore" more={{ to: '/collections', label: 'All collections' }}>
      <ul className="home-collections">
        {collections.map((c) => (
          <li key={c.id}>
            <Link to={`/c/${c.id}`} className="home-collection">
              <span className="home-collection-kind">{c.kind === 'place' ? 'Place' : 'Theme'}</span>
              <span className="home-collection-title">{c.title}</span>
              <span className="home-collection-desc muted small">{c.description}</span>
              <span className="muted small">{c.storyCount} {c.storyCount === 1 ? 'story' : 'stories'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
