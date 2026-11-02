import { cellToLatLng } from 'h3-js';
import type { DateParts, EventDate } from './dates.js';

/**
 * What kind of event a story is about. A story has 1–3 of them; the map and lists filter by them.
 * Order is the order they are offered in the editor and filters.
 */
export const CATEGORIES = ['war', 'protest', 'politics', 'science', 'disaster', 'culture', 'landmark', 'local'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  war: 'War & conflict',
  protest: 'Protest',
  politics: 'Political decision',
  science: 'Science & discovery',
  disaster: 'Disaster',
  culture: 'Cultural movement',
  landmark: 'Historical landmark',
  local: 'Local event',
};

/**
 * How one story relates to another, read from the story that holds the link:
 * "this story was preceded by X", "this story led to X", "this story is part of X", "includes X".
 * Each link is shown on both stories: on X it appears with the inverse relation.
 */
export const LINK_RELATIONS = ['preceded-by', 'led-to', 'part-of', 'includes', 'related'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export const INVERSE_RELATION: Record<LinkRelation, LinkRelation> = {
  'preceded-by': 'led-to',
  'led-to': 'preceded-by',
  'part-of': 'includes',
  includes: 'part-of',
  related: 'related',
};

export const RELATION_LABELS: Record<LinkRelation, string> = {
  'preceded-by': 'Preceded by',
  'led-to': 'Led to',
  'part-of': 'Part of',
  includes: 'Includes',
  related: 'Related',
};

/** How lists can be ordered. `relevance` needs a context (a search, a region); otherwise it falls back to significance. */
export const STORY_SORTS = ['occurred', 'published', 'updated', 'significance', 'relevance'] as const;
export type StorySort = (typeof STORY_SORTS)[number];

export const STORY_SORT_LABELS: Record<StorySort, string> = {
  occurred: 'When it happened',
  published: 'Newly published',
  updated: 'Latest updates',
  significance: 'Most connected',
  relevance: 'Most relevant',
};

/**
 * `new`: events written about while they were recent (within a year of publication).
 * `historical`: accounts of older events, newly added to the record.
 */
export const STORY_KINDS = ['all', 'new', 'historical'] as const;
export type StoryKind = (typeof STORY_KINDS)[number];

/** A story is a "historical account" when the latest date it touches is more than a year before it was published. */
export const HISTORICAL_GAP_DAYS = 365;

/** Developments in the last this-many days make an event count as "developing" (besides ongoing ones). */
export const DEVELOPING_DAYS = 30;

const fill = ({ year, month, day }: DateParts, high: boolean) =>
  year * 10_000 + (month ?? (high ? 12 : 1)) * 100 + (day ?? (high ? 31 : 1));

/** Largest key a date can have; used for "still ongoing". */
export const OPEN_END_KEY = 2_147_483_647;

/**
 * The span of time an event covers, as comparable keys (year*10000 + month*100 + day). Missing parts
 * widen the span: "1848" covers 1 January to 31 December 1848. Ongoing events never end.
 * Mirrored in SQL by `dateRangeSql` (apps/api/src/services/stories.ts).
 */
export function eventRange({ start, end, isOngoing }: Pick<EventDate, 'start' | 'end' | 'isOngoing'>): { lo: number; hi: number } {
  const lo = fill(start, false);
  const hi = isOngoing ? OPEN_END_KEY : fill(end ?? start, true);
  return { lo, hi: Math.max(lo, hi) };
}

/** Keys for a filter from the start of year `from` to the end of year `to` (either may be open). */
export function yearRangeKeys(from: number | null | undefined, to: number | null | undefined): { lo: number; hi: number } {
  return {
    lo: from == null ? -OPEN_END_KEY : from * 10_000 + 101,
    hi: to == null ? OPEN_END_KEY : to * 10_000 + 1231,
  };
}

export const overlaps = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => a.lo <= b.hi && a.hi >= b.lo;

/** Historical eras used to colour the map's "period" layer. `until` is the last year included. */
export const PERIODS = [
  { id: 'ancient', label: 'Before 500', until: 499 },
  { id: 'medieval', label: '500–1499', until: 1499 },
  { id: 'early-modern', label: '1500–1799', until: 1799 },
  { id: 'c19', label: '1800s', until: 1899 },
  { id: 'c20', label: '1900–1999', until: 1999 },
  { id: 'c21', label: '2000 onwards', until: Infinity },
] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];

export function periodOf(year: number): PeriodId {
  return PERIODS.find((p) => year <= p.until)!.id;
}

/**
 * A representative point for a set of H3 cells (the mean of their centres on the sphere), for stories
 * written before precise locations existed. Works across the antimeridian.
 */
export function cellsCenter(cells: readonly string[]): { lat: number; lng: number } | null {
  if (!cells.length) return null;
  let x = 0, y = 0, z = 0;
  for (const cell of cells) {
    const [lat, lng] = cellToLatLng(cell);
    const φ = (lat * Math.PI) / 180, λ = (lng * Math.PI) / 180;
    x += Math.cos(φ) * Math.cos(λ);
    y += Math.cos(φ) * Math.sin(λ);
    z += Math.sin(φ);
  }
  const lng = (Math.atan2(y, x) * 180) / Math.PI;
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dφ = (b.lat - a.lat) * rad, dλ = (b.lng - a.lng) * rad;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dλ / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Collapses whitespace so a quoted statement matches the story text however it was copied. */
export const normalizeQuote = (text: string) => text.replace(/\s+/g, ' ').trim();
