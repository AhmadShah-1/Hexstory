import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { getResolution } from 'h3-js';
import { LIMITS, toBaseCells, type Category } from '@hexstory/shared';
import type { StoryFilters } from '../api/queries';
import { cellsBounds } from './geo';

/** Zoom at which a cell of each resolution is the one shown (inverse of resForZoom). */
const ZOOM_FOR_RES: Record<number, number> = { 0: 2, 1: 2.5, 2: 3, 3: 4.2, 4: 5.7, 5: 7 };

export type MapMode = 'browse' | 'select';

/**
 * What the map draws. `events`: one neutral dot per story. `density`: hexagons shaded by how many
 * stories were written there (not how important a place is). `category` / `period`: dots coloured by
 * kind of event or by era. `developing`: only ongoing events and those with recent developments.
 */
export const MAP_LAYERS = ['events', 'density', 'category', 'period', 'developing'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/** Time and category filters; they apply to the map and to every list that follows the map. */
export interface MapFilters {
  /** Inclusive years; null = open. */
  from: number | null;
  to: number | null;
  categories: Category[];
}
export const NO_FILTERS: MapFilters = { from: null, to: null, categories: [] };
export const hasFilters = (f: MapFilters) => f.from !== null || f.to !== null || f.categories.length > 0;
/** The filters as list query parameters. */
export const filtersQuery = (f: MapFilters): StoryFilters => ({
  from: f.from ?? undefined,
  to: f.to ?? undefined,
  categories: f.categories.length ? f.categories : undefined,
});

export type LatLng = { lat: number; lng: number };
/** A labelled point drawn on top of the stories, e.g. a development of the story being read. */
export interface MapMarker extends LatLng {
  id: string;
  label: string;
}

/** In select mode (the editors): clicks set the story's point, or add/remove hexagons of its area. */
export type SelectTool = 'point' | 'area';

interface MapContextValue {
  /** 'select' while the story editor is open: clicks toggle regions instead of opening them. */
  mode: MapMode;
  setMode(mode: MapMode): void;
  /** Base-resolution cells picked in the editor. */
  selection: Set<string>;
  setSelection(cells: Iterable<string>): void;
  /** Adds or removes a clicked display cell; returns false if the area would become too large. */
  toggleCell(cell: string): boolean;
  /** Most base cells the selection may hold: stories' LIMITS.cellsMax by default; collections allow more. */
  setSelectionLimit(limit: number): void;
  /** The hex whose panel is open. */
  activeCell: string | null;
  setActiveCell(cell: string | null): void;
  /** Compact cells of the story being read, drawn as its footprint. */
  storyCells: string[];
  setStoryCells(cells: string[]): void;
  /** Point of the story being read, drawn as a pin. */
  storyPoint: LatLng | null;
  setStoryPoint(point: LatLng | null): void;
  /** Extra labelled points (a story's developments). */
  markers: MapMarker[];
  setMarkers(markers: MapMarker[]): void;
  /** Story ids to emphasise (e.g. a collection being read); the rest fade. Null: none. */
  highlight: string[] | null;
  setHighlight(ids: string[] | null): void;
  /** What the map draws, and the time/category filters (shared with lists). */
  layer: MapLayer;
  setLayer(layer: MapLayer): void;
  filters: MapFilters;
  setFilters(next: MapFilters | ((prev: MapFilters) => MapFilters)): void;
  /** Select mode: which tool clicks use, and the point being placed. */
  tool: SelectTool;
  setTool(tool: SelectTool): void;
  point: LatLng | null;
  setPoint(point: LatLng | null): void;
  /** Moves the map to show these points (beside the panel), like focusCells. */
  focusPoints(points: LatLng[], opts?: { onlyIfHidden?: boolean; maxZoom?: number }): void;
  /**
   * Moves the map so these cells are visible beside the panel. With `onlyIfHidden`, the camera
   * stays put when they are already in view, so it never jumps right after a click.
   * Requests made before the map has loaded are applied once it is ready.
   */
  focusCells(cells: string[], opts?: { onlyIfHidden?: boolean }): void;
  registerMap(map: MapLibreMap | null): void;
}

const MapContext = createContext<MapContextValue | null>(null);

export function useMapState(): MapContextValue {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error('useMapState must be used inside <MapProvider>');
  return ctx;
}

export const isNarrowScreen = () => window.matchMedia('(max-width: 720px)').matches;

/** Padding that keeps focused areas out from under the panel (side panel on desktop, sheet on mobile). */
export function panelPadding() {
  return isNarrowScreen()
    ? { top: 70, left: 30, right: 30, bottom: Math.round(window.innerHeight * 0.58) + 20 }
    : { top: 80, left: 60, bottom: 60, right: 480 };
}

export function MapProvider({ children }: { children: ReactNode }) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mode, setMode] = useState<MapMode>('browse');
  const [selection, setSelectionState] = useState<Set<string>>(new Set());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [storyCells, setStoryCells] = useState<string[]>([]);
  const [storyPoint, setStoryPoint] = useState<LatLng | null>(null);
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [highlight, setHighlight] = useState<string[] | null>(null);
  const [layer, setLayerState] = useState<MapLayer>(readLayer);
  const [filters, setFilters] = useState<MapFilters>(NO_FILTERS);
  const [tool, setTool] = useState<SelectTool>('point');
  const [point, setPoint] = useState<LatLng | null>(null);
  const setLayer = useCallback((next: MapLayer) => {
    setLayerState(next);
    try {
      localStorage.setItem(LAYER_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts this visit */
    }
  }, []);

  const setSelection = useCallback((cells: Iterable<string>) => setSelectionState(new Set(cells)), []);

  const limitRef = useRef<number>(LIMITS.cellsMax);
  const setSelectionLimit = useCallback((limit: number) => {
    limitRef.current = limit;
  }, []);

  const toggleCell = useCallback((cell: string) => {
    const children = toBaseCells([cell]);
    const prev = selectionRef.current;
    const next = new Set(prev);
    const removing = children.every((c) => prev.has(c));
    if (removing) children.forEach((c) => next.delete(c));
    else children.forEach((c) => next.add(c));
    // Removing is always allowed, so an area that is already too big can still be trimmed.
    if (!removing && next.size > limitRef.current) return false;
    selectionRef.current = next;
    setSelectionState(next);
    return true;
  }, []);

  const pendingFocus = useRef<(() => void) | null>(null);

  const focusCells = useCallback((cells: string[], opts: { onlyIfHidden?: boolean } = {}) => {
    const bounds = cellsBounds(cells);
    if (!bounds) return;
    const run = (map: MapLibreMap) => {
      if (opts.onlyIfHidden && boundsVisible(map, bounds)) return;
      const coarsest = Math.min(...cells.map(getResolution));
      map.fitBounds(bounds, { padding: panelPadding(), maxZoom: ZOOM_FOR_RES[coarsest] ?? 7, duration: 900 });
    };
    if (mapRef.current) run(mapRef.current);
    else pendingFocus.current = () => mapRef.current && run(mapRef.current);
  }, []);

  const focusPoints = useCallback((points: LatLng[], opts: { onlyIfHidden?: boolean; maxZoom?: number } = {}) => {
    if (!points.length) return;
    const lngs = points.map((p) => p.lng), lats = points.map((p) => p.lat);
    const bounds: [[number, number], [number, number]] = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
    const run = (map: MapLibreMap) => {
      if (opts.onlyIfHidden && boundsVisible(map, bounds)) return;
      map.fitBounds(bounds, { padding: panelPadding(), maxZoom: opts.maxZoom ?? (points.length === 1 ? 7 : 9), duration: 900 });
    };
    if (mapRef.current) run(mapRef.current);
    else pendingFocus.current = () => mapRef.current && run(mapRef.current);
  }, []);

  const registerMap = useCallback((map: MapLibreMap | null) => {
    mapRef.current = map;
    if (map && pendingFocus.current) {
      pendingFocus.current();
      pendingFocus.current = null;
    }
  }, []);

  const value = useMemo(
    () => ({
      mode, setMode, selection, setSelection, toggleCell, setSelectionLimit, activeCell, setActiveCell,
      storyCells, setStoryCells, storyPoint, setStoryPoint, markers, setMarkers, highlight, setHighlight,
      layer, setLayer, filters, setFilters, tool, setTool, point, setPoint,
      focusCells, focusPoints, registerMap,
    }),
    [mode, selection, setSelection, toggleCell, setSelectionLimit, activeCell, storyCells, storyPoint, markers, highlight,
      layer, setLayer, filters, tool, point, focusCells, focusPoints, registerMap],
  );
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
}

const LAYER_KEY = 'hexstory:map-layer';
function readLayer(): MapLayer {
  try {
    const saved = localStorage.getItem(LAYER_KEY);
    return (MAP_LAYERS as readonly string[]).includes(saved ?? '') ? (saved as MapLayer) : 'events';
  } catch {
    return 'events';
  }
}

/** True when the bounds' corners all project inside the part of the map not covered by the panel. */
function boundsVisible(map: MapLibreMap, [[west, south], [east, north]]: [[number, number], [number, number]]): boolean {
  const pad = panelPadding();
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  return [[west, south], [east, north], [west, north], [east, south]].every(([lng, lat]) => {
    const p = map.project([lng!, lat!]);
    return p.x >= pad.left && p.x <= w - pad.right && p.y >= pad.top && p.y <= h - pad.bottom;
  });
}
