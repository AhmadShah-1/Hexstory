import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { overlaps, yearRangeKeys, type MapPoint } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { randomStoryId } from '../api/queries';
import { useToast } from '../components/Toast';
import type { MapFilters } from '../map/MapContext';

/**
 * The map's time and category filters applied to points in the browser, so dragging the timeline or
 * toggling a category costs no request. A point matches a time filter when the span of the event
 * overlaps it (a war 1914–1918 shows in "1916"), and a category filter when it shares any category.
 */
export function filterPoints(points: readonly MapPoint[], f: MapFilters): MapPoint[] {
  const range = f.from !== null || f.to !== null ? yearRangeKeys(f.from, f.to) : null;
  const cats = f.categories.length ? new Set(f.categories) : null;
  return points.filter((p) => (!range || overlaps(p, range)) && (!cats || p.categories.some((c) => cats.has(c))));
}

// ---------------------------------------------------------------------------------------------
// The timeline's year scale. Most recorded history is recent, so a linear slider would squeeze the
// last two centuries into a sliver. The slider runs 0..SCALE_MAX and maps piecewise onto years:
// ancient history is compressed, recent centuries get most of the width.

export const SCALE_MAX = 1000;
const CURRENT_YEAR = new Date().getFullYear();
/** [slider position, year] breakpoints; years are historical (negative = BCE). */
const STOPS: [number, number][] = [
  [0, -3000],
  [120, -1],
  [300, 1500],
  [550, 1900],
  [SCALE_MAX, CURRENT_YEAR],
];
export const MIN_YEAR = STOPS[0]![1];
export const MAX_YEAR = CURRENT_YEAR;

/** Slider position → year (never 0: there is no year 0). */
export function positionToYear(pos: number): number {
  const p = Math.max(0, Math.min(SCALE_MAX, pos));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, y1] = STOPS[i]!;
    const [p0, y0] = STOPS[i - 1]!;
    if (p <= p1) {
      const year = Math.round(y0 + ((p - p0) / (p1 - p0)) * (y1 - y0));
      return year === 0 ? 1 : year;
    }
  }
  return CURRENT_YEAR;
}

/** Year → slider position (inverse of positionToYear). */
export function yearToPosition(year: number): number {
  const y = Math.max(MIN_YEAR, Math.min(MAX_YEAR, year));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, y1] = STOPS[i]!;
    const [p0, y0] = STOPS[i - 1]!;
    if (y <= y1) return Math.round(p0 + ((y - y0) / (y1 - y0)) * (p1 - p0));
  }
  return SCALE_MAX;
}

export const formatYear = (year: number) => (year < 0 ? `${-year} BCE` : `${year}`);

/** "All time", "1916", "The 1960s", "1914–1918", "Until 1500", "From 1900". */
export function describeRange(from: number | null, to: number | null): string {
  if (from === null && to === null) return 'All time';
  if (from !== null && to === null) return `From ${formatYear(from)}`;
  if (from === null && to !== null) return `Until ${formatYear(to)}`;
  if (from === to) return formatYear(from!);
  if (from! > 0 && from! % 10 === 0 && to === from! + 9) return `The ${from}s`;
  return `${formatYear(from!)}–${formatYear(to!)}`;
}

/**
 * "Surprise me" / "Explore a random event": asks the API for a random published story and opens it.
 * While the site is young there may be none yet; then it says so kindly.
 */
export function useRandomStory() {
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = useCallback(
    async (mode: 'surprise' | 'any') => {
      setBusy(true);
      try {
        const id = await randomStoryId(mode);
        if (id) navigate(`/s/${id}`);
        else toast('No stories have been published yet. Yours could be the first.');
      } catch (err) {
        toast(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [navigate, toast],
  );
  return { go, busy };
}

/** Today's month and day as the API's "MM-DD", and a readable "7 March". */
export function today() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return {
    param: `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    label: now.toLocaleDateString(undefined, { day: 'numeric', month: 'long' }),
  };
}

/**
 * Density bins (lower bounds of stories per hexagon) for the density layer and its legend. Few, coarse
 * bins on purpose: the layer shows where people have written, not a ranking of places.
 */
export const DENSITY_BINS = [1, 2, 4, 10, 25] as const;
export const densityBin = (count: number) => {
  let bin = 0;
  DENSITY_BINS.forEach((min, i) => {
    if (count >= min) bin = i;
  });
  return bin;
};
