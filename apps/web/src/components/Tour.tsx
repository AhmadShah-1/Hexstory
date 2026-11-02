import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { isNarrowScreen } from '../map/MapContext';

/**
 * A short guided tour of the main features: where to start, what a story looks like, the map, place
 * search, time and layers, collections, and how to contribute. Each step spotlights one part of the
 * page (the first visible match of its selectors, so phones and desktops can point at different
 * elements) and explains it in two or three sentences; a step whose element isn't on screen shows its
 * card in the middle instead. No library: a dimmed overlay with a cut-out and a card.
 */
interface Step {
  title: string;
  body: ReactNode;
  /** CSS selectors to spotlight, first visible one wins. None: a centred card. */
  targets?: string[];
  /** Keep the map visible (no dimming) for steps about the map itself. */
  clear?: boolean;
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Hexstory',
    body: (
      <>
        A map of connected, sourced history: what happened where, and how events relate to each other.
        This quick tour shows the main features. It takes about a minute.
      </>
    ),
  },
  {
    title: 'Start here',
    targets: ['.discover-actions'],
    body: (
      <>
        Not sure where to begin? <strong>Surprise me</strong> picks a well-sourced story, <strong>History near
        me</strong> finds what happened around you (your location never leaves your device), and{' '}
        <strong>On this day</strong> shows events from today's date.
      </>
    ),
  },
  {
    title: 'Stories at a glance',
    targets: ['.home .story-row', '.home .young-site'],
    body: (
      <>
        Every story shows when and where it happened, a short summary, its categories and how many sources it
        lists. Open one to see the summary and sources first, how it connects to causes and consequences, and a
        timeline of developments for ongoing events.
      </>
    ),
  },
  {
    title: 'The map',
    clear: true,
    body: (
      <>
        Each dot is an event, at the place it happened. Click a dot to read it, or click anywhere else to see
        everything recorded in that region. Drag to move, scroll or pinch to zoom.
      </>
    ),
  },
  {
    title: 'Jump to a place',
    targets: ['.place-search'],
    body: <>Type a town, a region or a country and the map flies there, with the stories recorded around it.</>,
  },
  {
    title: 'Travel through time',
    targets: ['.map-controls-body', '.map-controls-pill'],
    body: (
      <>
        Pick a year, a decade or a range and the map shows only what happened then. Under{' '}
        <strong>Categories &amp; layers</strong> you can show only wars, protests, discoveries and more, colour the
        map by kind or era, or show only events still developing.
      </>
    ),
  },
  {
    title: 'Collections',
    targets: ['.footer-links a[href="/collections"]'],
    body: (
      <>
        Stories grouped into narratives: the history of a place, or a theme such as a revolution or the end of
        empires. Read them in order or by date, and see them highlighted on the map.
      </>
    ),
  },
  {
    title: 'Add to the record',
    targets: ['.account'],
    body: (
      <>
        Sign in to write stories, add developments to ongoing events, and dispute statements you think are wrong,
        with your evidence. A reviewer checks new writers' first stories; careful, well-sourced work earns trust.
      </>
    ),
  },
  {
    title: "You're all set",
    body: <>You can take this tour again any time with the <strong>?</strong> button at the top of the page.</>,
  },
];

const SEEN_KEY = 'hexstory:tour-seen';
const PAD = 8;
const GAP = 12;

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // storage blocked: don't keep inviting
  }
}
export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/** Asks the home panel to open (it may be collapsed to its pill). */
export const OPEN_HOME_EVENT = 'hexstory:open-home';

const TourContext = createContext<{ start(): void; active: boolean }>({ start: () => {}, active: false });
export const useTour = () => useContext(TourContext);

export function TourProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<number | null>(null);
  const navigate = useNavigate();
  const opener = useRef<HTMLElement | null>(null);

  const start = useCallback(() => {
    opener.current = document.activeElement as HTMLElement | null;
    // The tour walks through the home page, so go there and make sure its panel is open.
    navigate('/');
    window.dispatchEvent(new Event(OPEN_HOME_EVENT));
    setStep(0);
  }, [navigate]);

  const close = useCallback(() => {
    markTourSeen();
    setStep(null);
    opener.current?.focus?.();
  }, []);

  const value = useMemo(() => ({ start, active: step !== null }), [start, step]);
  return (
    <TourContext.Provider value={value}>
      {children}
      {step !== null && <TourOverlay step={step} setStep={setStep} onClose={close} />}
    </TourContext.Provider>
  );
}

type Rect = { top: number; left: number; width: number; height: number };

function findTarget(selectors: string[] | undefined): HTMLElement | null {
  for (const selector of selectors ?? []) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
    }
  }
  return null;
}

function TourOverlay({ step, setStep, onClose }: { step: number; setStep: (n: number) => void; onClose: () => void }) {
  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);

  // Find the step's element (bringing it into view inside a scrolling panel) and follow it while the
  // page settles: panels animate in, and the home page's stories load a moment after it opens.
  useEffect(() => {
    let frame = 0;
    let scrolled = false;
    const startedAt = performance.now();
    const measure = () => {
      const el = findTarget(current.targets);
      if (el && !scrolled) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        scrolled = true;
      }
      const r = el?.getBoundingClientRect();
      setRect((prev) => {
        const nextRect = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
        const same = prev && nextRect && Math.abs(prev.top - nextRect.top) < 0.5 && Math.abs(prev.left - nextRect.left) < 0.5
          && Math.abs(prev.width - nextRect.width) < 0.5 && Math.abs(prev.height - nextRect.height) < 0.5;
        return same || (!prev && !nextRect) ? prev : nextRect;
      });
      if (performance.now() - startedAt < 1500) frame = requestAnimationFrame(measure);
    };
    measure();
    const onResize = () => {
      cancelAnimationFrame(frame);
      measure();
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [current]);

  // Place the card beside the spotlight where it fits; on phones dock it to the opposite edge.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const { width: cw, height: ch } = el.getBoundingClientRect();
    const clamp = (v: number, max: number) => Math.max(GAP, Math.min(v, max - GAP));
    if (!rect) {
      setCardPos({ top: clamp((vh - ch) / 2, vh - ch), left: current.clear && !isNarrowScreen() ? GAP * 3 : clamp((vw - cw) / 2, vw - cw) });
      return;
    }
    if (isNarrowScreen()) {
      const below = rect.top + rect.height / 2 < vh / 2;
      setCardPos({ top: below ? vh - ch - GAP : GAP, left: clamp((vw - cw) / 2, vw - cw) });
      return;
    }
    const hole = { top: rect.top - PAD, left: rect.left - PAD, bottom: rect.top + rect.height + PAD, right: rect.left + rect.width + PAD };
    const centreX = clamp(rect.left + rect.width / 2 - cw / 2, vw - cw);
    const centreY = clamp(rect.top + rect.height / 2 - ch / 2, vh - ch);
    if (hole.bottom + GAP + ch <= vh - GAP) setCardPos({ top: hole.bottom + GAP, left: centreX });
    else if (hole.top - GAP - ch >= GAP) setCardPos({ top: hole.top - GAP - ch, left: centreX });
    else if (hole.left - GAP - cw >= GAP) setCardPos({ top: centreY, left: hole.left - GAP - cw });
    else setCardPos({ top: centreY, left: clamp(hole.right + GAP, vw - cw) });
  }, [rect, step, current.clear]);

  useEffect(() => next.current?.focus(), [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't also close the panel underneath
        onClose();
      } else if (e.key === 'ArrowRight' && !last) setStep(step + 1);
      else if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [step, last, setStep, onClose]);

  const dim = !current.clear;
  return (
    <div className={`tour ${dim && !rect ? 'tour-dim' : ''}`} role="presentation">
      {rect && (
        <div
          className="tour-spotlight"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      )}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={cardPos ? { top: cardPos.top, left: cardPos.left } : { visibility: 'hidden' }}
      >
        <p className="tour-progress muted small">{step + 1} of {STEPS.length}</p>
        <h2 id="tour-title" className="tour-title">{current.title}</h2>
        <p id="tour-body" className="tour-body">{current.body}</p>
        <div className="tour-actions">
          {!last && <button type="button" className="link-button" onClick={onClose}>Skip tour</button>}
          <span className="tour-spacer" />
          {step > 0 && <button type="button" className="button" onClick={() => setStep(step - 1)}>Back</button>}
          <button ref={next} type="button" className="button button-primary" onClick={() => (last ? onClose() : setStep(step + 1))}>
            {last ? 'Start exploring' : step === 0 ? 'Show me around' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "?" button in the top bar: the tour is always one click away. */
export function TourButton() {
  const { start } = useTour();
  return (
    <button type="button" className="tour-button" onClick={start} aria-label="Take the tour" title="Take the tour">
      ?
    </button>
  );
}

/** A one-time invitation on the home panel for first-time visitors. */
export function TourInvite() {
  const { start, active } = useTour();
  const [hidden, setHidden] = useState(tourSeen);
  if (hidden || active) return null;
  return (
    <div className="tour-invite">
      <div>
        <p className="tour-invite-title">New here?</p>
        <p className="muted small">A one-minute tour of the main features.</p>
      </div>
      <div className="row">
        <button type="button" className="button button-primary" onClick={() => { setHidden(true); start(); }}>Take the tour</button>
        <button type="button" className="link-button" onClick={() => { markTourSeen(); setHidden(true); }}>No thanks</button>
      </div>
    </div>
  );
}
