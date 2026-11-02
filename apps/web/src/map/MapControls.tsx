import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY_LABELS, DEVELOPING_DAYS, PERIODS } from '@hexstory/shared';
import { useMapPoints } from '../api/queries';
import { CategoryPicker } from '../components/Categories';
import {
  DENSITY_BINS,
  MAX_YEAR,
  MIN_YEAR,
  SCALE_MAX,
  describeRange,
  filterPoints,
  positionToYear,
  yearToPosition,
} from '../lib/discover';
import { CATEGORY_COLORS, DENSITY_RAMP, DEVELOPING_COLOR, EVENT_COLOR, PERIOD_COLORS } from '../lib/palette';
import { MAP_LAYERS, NO_FILTERS, hasFilters, useMapState, type MapLayer } from './MapContext';

type TimeMode = 'all' | 'year' | 'decade' | 'range';
const TIME_MODES: { id: TimeMode; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'year', label: 'Year' },
  { id: 'decade', label: 'Decade' },
  { id: 'range', label: 'Range' },
];

const LAYER_INFO: Record<MapLayer, { label: string; description: string }> = {
  events: { label: 'Events', description: 'Every story as a dot' },
  density: { label: 'Density', description: 'Where stories have been written so far' },
  category: { label: 'Category', description: 'Dots coloured by kind of event' },
  period: { label: 'Historical period', description: 'Dots coloured by era' },
  developing: { label: 'Developing', description: `Ongoing events, or updated in the last ${DEVELOPING_DAYS} days` },
};

const decadeOf = (year: number) => Math.floor(year / 10) * 10;
/** A year the filters can use (there is no year 0). */
const validYear = (y: number) => (y === 0 ? 1 : Math.max(MIN_YEAR, Math.min(MAX_YEAR, y)));

/** Which timeline mode current filters correspond to (used when they were set elsewhere, e.g. cleared). */
function modeOf(from: number | null, to: number | null, current: TimeMode): TimeMode {
  if (from === null && to === null) return 'all';
  if (current !== 'all') return current;
  return from === to ? 'year' : 'range';
}

/**
 * The map's time, category and layer controls: a quiet bar at the bottom of the map on desktop, a
 * "Filters" button opening a sheet on phones. Everything applies live: the map filters its points in
 * the browser, so dragging the timeline costs no requests. Hidden while writing (select mode).
 */
export function MapControls() {
  const { mode, filters, setFilters, layer, setLayer } = useMapState();
  const points = useMapPoints();
  const [timeMode, setTimeMode] = useState<TimeMode>('all');
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(false);

  const effectiveMode = modeOf(filters.from, filters.to, timeMode);
  useEffect(() => {
    if (effectiveMode !== timeMode) setTimeMode(effectiveMode);
  }, [effectiveMode, timeMode]);

  const matching = useMemo(() => {
    const all = filterPoints(points.data ?? [], filters);
    return layer === 'developing' ? all.filter((p) => p.developing).length : all.length;
  }, [points.data, filters, layer]);

  if (mode === 'select') return null;

  const anchor = filters.from ?? filters.to ?? 1900;
  const chooseMode = (next: TimeMode) => {
    setTimeMode(next);
    if (next === 'all') setFilters((f) => ({ ...f, from: null, to: null }));
    else if (next === 'year') setFilters((f) => ({ ...f, from: anchor, to: anchor }));
    else if (next === 'decade') setFilters((f) => ({ ...f, from: decadeOf(anchor), to: decadeOf(anchor) + 9 }));
    else setFilters((f) => ({ ...f, from: f.from ?? 1900, to: f.to !== null && f.to !== f.from ? f.to : MAX_YEAR }));
  };
  const setYear = (year: number) => {
    const y = validYear(year);
    if (timeMode === 'decade') setFilters((f) => ({ ...f, from: decadeOf(y), to: decadeOf(y) + 9 }));
    else setFilters((f) => ({ ...f, from: y, to: y }));
  };
  const setRange = (from: number, to: number) =>
    setFilters((f) => ({ ...f, from: validYear(Math.min(from, to)), to: validYear(Math.max(from, to)) }));
  const clear = () => {
    setTimeMode('all');
    setFilters(NO_FILTERS);
  };

  const label = describeRange(filters.from, filters.to);
  const countText = points.data ? `${matching.toLocaleString()} ${matching === 1 ? 'event' : 'events'}` : '';
  const categoryCount = filters.categories.length;

  return (
    <div className={`map-controls ${sheet ? 'is-open' : ''}`}>
      <button className="map-controls-pill button button-floating" onClick={() => setSheet(true)} aria-expanded={sheet}>
        Filters · {label}
        {categoryCount > 0 && ` · ${categoryCount} ${categoryCount === 1 ? 'category' : 'categories'}`}
      </button>

      <section className="map-controls-body" aria-label="Map filters and layers">
        <div className="map-controls-row">
          <div className="segmented-pills" role="group" aria-label="Time period">
            {TIME_MODES.map((m) => (
              <button key={m.id} type="button" aria-pressed={timeMode === m.id} onClick={() => chooseMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="map-controls-summary" aria-live="polite">
            <strong>{label}</strong>
            {countText && <span className="muted"> · {countText}</span>}
          </div>
          <button type="button" className="link-button map-controls-more-toggle" aria-expanded={more} onClick={() => setMore((v) => !v)}>
            {more ? 'Fewer options' : `Categories & layers${categoryCount ? ` (${categoryCount})` : ''}`}
          </button>
          <button type="button" className="icon-button map-controls-close" aria-label="Close filters" onClick={() => setSheet(false)}>×</button>
        </div>

        {timeMode !== 'all' && (
          <div className="map-controls-row map-timeline">
            {timeMode === 'range' ? (
              <RangeSlider from={filters.from ?? MIN_YEAR} to={filters.to ?? MAX_YEAR} onChange={setRange} />
            ) : (
              <input
                type="range"
                className="timeline-slider"
                min={0}
                max={SCALE_MAX}
                value={yearToPosition(filters.from ?? anchor)}
                aria-label={timeMode === 'decade' ? 'Decade' : 'Year'}
                aria-valuetext={label}
                onChange={(e) => setYear(positionToYear(Number(e.target.value)))}
              />
            )}
            <div className="timeline-years">
              {timeMode === 'range' ? (
                <>
                  <YearInput label="From year" value={filters.from ?? MIN_YEAR} onCommit={(y) => setRange(y, filters.to ?? MAX_YEAR)} />
                  <span aria-hidden="true">–</span>
                  <YearInput label="To year" value={filters.to ?? MAX_YEAR} onCommit={(y) => setRange(filters.from ?? MIN_YEAR, y)} />
                </>
              ) : (
                <YearInput label={timeMode === 'decade' ? 'Decade starting' : 'Year'} value={filters.from ?? anchor} onCommit={setYear} />
              )}
            </div>
          </div>
        )}

        {(more || sheet) && (
          <div className="map-controls-more">
            <div>
              <h2 className="map-controls-heading">Categories</h2>
              <p className="muted small">None selected shows every kind of event.</p>
              <CategoryPicker label="Show categories" value={filters.categories} onChange={(categories) => setFilters((f) => ({ ...f, categories }))} />
            </div>
            <div>
              <h2 className="map-controls-heading">The map shows</h2>
              <div className="layer-options" role="radiogroup" aria-label="Map layer">
                {MAP_LAYERS.map((id) => (
                  <label key={id} className={`layer-option ${layer === id ? 'is-on' : ''}`}>
                    <input type="radio" name="map-layer" checked={layer === id} onChange={() => setLayer(id)} />
                    <span>
                      <span className="layer-name">{LAYER_INFO[id].label}</span>
                      <span className="muted small">{LAYER_INFO[id].description}</span>
                    </span>
                  </label>
                ))}
              </div>
              <Legend layer={layer} />
            </div>
            <div className="map-controls-actions">
              {(hasFilters(filters) || timeMode !== 'all') && (
                <button type="button" className="button" onClick={clear}>Clear filters</button>
              )}
              <button type="button" className="button button-primary map-controls-done" onClick={() => setSheet(false)}>
                Show {countText || 'results'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Two thumbs on one track (two overlaid range inputs; each stays keyboard-accessible on its own). */
function RangeSlider({ from, to, onChange }: { from: number; to: number; onChange: (from: number, to: number) => void }) {
  const a = yearToPosition(from);
  const b = yearToPosition(to);
  return (
    <div className="range-slider" style={{ '--a': `${(a / SCALE_MAX) * 100}%`, '--b': `${(b / SCALE_MAX) * 100}%` } as React.CSSProperties}>
      <input
        type="range"
        min={0}
        max={SCALE_MAX}
        value={a}
        aria-label="From"
        aria-valuetext={describeRange(from, from)}
        onChange={(e) => onChange(positionToYear(Math.min(Number(e.target.value), b)), to)}
      />
      <input
        type="range"
        min={0}
        max={SCALE_MAX}
        value={b}
        aria-label="To"
        aria-valuetext={describeRange(to, to)}
        onChange={(e) => onChange(from, positionToYear(Math.max(Number(e.target.value), a)))}
      />
    </div>
  );
}

/**
 * Exact year entry (negative numbers are BCE). Keeps its own text while typing, so "-" or an
 * empty box don't snap back, and applies the year once it is a valid number.
 */
function YearInput({ label, value, onCommit }: { label: string; value: number; onCommit: (year: number) => void }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() && Number.isInteger(n) && n !== 0) onCommit(n);
  };
  return (
    <label className="year-input">
      <span className="visually-hidden">{label} (negative for BCE)</span>
      <input
        inputMode="numeric"
        value={text}
        title="Negative years are BCE"
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          setText(String(value));
        }}
        onChange={(e) => {
          const next = e.target.value.replace(/[^\d-]/g, '').slice(0, 6);
          setText(next);
          commit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function Swatch({ color, ring = false }: { color: string; ring?: boolean }) {
  return <span className={`legend-swatch ${ring ? 'legend-ring' : ''}`} style={{ background: color }} aria-hidden="true" />;
}

/** What the colours mean on the active layer. */
function Legend({ layer }: { layer: MapLayer }) {
  if (layer === 'density') {
    const labels = DENSITY_BINS.map((min, i) => {
      const next = DENSITY_BINS[i + 1];
      return next === undefined ? `${min}+` : next - 1 === min ? `${min}` : `${min}–${next - 1}`;
    });
    return (
      <div className="map-legend">
        <ul className="legend-row">
          {labels.map((l, i) => (
            <li key={l}><Swatch color={DENSITY_RAMP[i]!} />{l}</li>
          ))}
        </ul>
        <p className="muted small">
          Stories per hexagon. This shows where people have written so far, not how important a place or its history is.
        </p>
      </div>
    );
  }
  if (layer === 'category') {
    return (
      <ul className="map-legend legend-row">
        {CATEGORIES.map((c) => (
          <li key={c}><Swatch color={CATEGORY_COLORS[c]} />{CATEGORY_LABELS[c]}</li>
        ))}
      </ul>
    );
  }
  if (layer === 'period') {
    return (
      <ul className="map-legend legend-row">
        {PERIODS.map((p) => (
          <li key={p.id}><Swatch color={PERIOD_COLORS[p.id]} />{p.label}</li>
        ))}
      </ul>
    );
  }
  if (layer === 'developing') {
    return (
      <p className="map-legend small"><Swatch color={DEVELOPING_COLOR} ring /> Ongoing or recently updated. Other events are hidden.</p>
    );
  }
  return <p className="map-legend small"><Swatch color={EVENT_COLOR} /> One dot per story, wherever it happened.</p>;
}
