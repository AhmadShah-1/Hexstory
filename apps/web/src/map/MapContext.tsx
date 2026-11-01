import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { getResolution } from 'h3-js';
import { LIMITS, toBaseCells } from '@hexstory/shared';
import { cellsBounds } from './geo';

/** Zoom at which a cell of each resolution is the one shown (inverse of resForZoom). */
const ZOOM_FOR_RES: Record<number, number> = { 0: 2, 1: 2.5, 2: 3, 3: 4.2, 4: 5.7, 5: 7 };

export type MapMode = 'browse' | 'select';

interface MapContextValue {
  /** 'select' while the story editor is open: clicks toggle regions instead of opening them. */
  mode: MapMode;
  setMode(mode: MapMode): void;
  /** Base-resolution cells picked in the editor. */
  selection: Set<string>;
  setSelection(cells: Iterable<string>): void;
  /** Adds or removes a clicked display cell; returns false if the area would become too large. */
  toggleCell(cell: string): boolean;
  /** The hex whose panel is open. */
  activeCell: string | null;
  setActiveCell(cell: string | null): void;
  /** Compact cells of the story being read, drawn as its footprint. */
  storyCells: string[];
  setStoryCells(cells: string[]): void;
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

  const setSelection = useCallback((cells: Iterable<string>) => setSelectionState(new Set(cells)), []);

  const toggleCell = useCallback((cell: string) => {
    const children = toBaseCells([cell]);
    const prev = selectionRef.current;
    const next = new Set(prev);
    if (children.every((c) => prev.has(c))) children.forEach((c) => next.delete(c));
    else children.forEach((c) => next.add(c));
    if (next.size > LIMITS.cellsMax) return false;
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

  const registerMap = useCallback((map: MapLibreMap | null) => {
    mapRef.current = map;
    if (map && pendingFocus.current) {
      pendingFocus.current();
      pendingFocus.current = null;
    }
  }, []);

  const value = useMemo(
    () => ({
      mode, setMode, selection, setSelection, toggleCell, activeCell, setActiveCell,
      storyCells, setStoryCells, focusCells, registerMap,
    }),
    [mode, selection, setSelection, toggleCell, activeCell, storyCells, focusCells, registerMap],
  );
  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
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
