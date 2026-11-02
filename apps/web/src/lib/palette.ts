import type { Category, PeriodId } from '@hexstory/shared';

/**
 * Colours for the map's category and period layers and the matching chips. Kept apart from the
 * terracotta accent (actions) and the blue used for "this story's area / your selection".
 */
export const CATEGORY_COLORS: Record<Category, string> = {
  war: '#b42318',
  protest: '#d97706',
  politics: '#4338ca',
  science: '#0e7490',
  disaster: '#44403c',
  culture: '#a21caf',
  landmark: '#15803d',
  local: '#8a6d1d',
};

/** Sequential (light = older, dark = recent), so periods read as an order rather than as categories. */
export const PERIOD_COLORS: Record<PeriodId, string> = {
  ancient: '#c4b5fd',
  medieval: '#a78bfa',
  'early-modern': '#8b5cf6',
  c19: '#7c3aed',
  c20: '#5b21b6',
  c21: '#3b0764',
};

/** Neutral dot colour for the default "events" layer. */
export const EVENT_COLOR = '#44403c';
/** Ongoing or recently developing events. */
export const DEVELOPING_COLOR = '#c2410c';
/** Density hexagons: a neutral grey-brown ramp, deliberately not the accent colour. */
export const DENSITY_RAMP = ['#e7e5e4', '#d6d3d1', '#a8a29e', '#78716c', '#57534e'] as const;
