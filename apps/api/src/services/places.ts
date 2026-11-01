import { cellAt, type Place } from '@hexstory/shared';

/**
 * Place search, backed by a Photon geocoder (https://github.com/komoot/photon; OpenStreetMap data).
 * Queries go through our API rather than from browsers, so visitors' addresses never reach the
 * geocoder, results can be cached, and the provider can be swapped (GEOCODER_URL).
 */

export interface PhotonFeature {
  properties: {
    name?: string;
    type?: string;
    osm_key?: string;
    osm_value?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
    extent?: [number, number, number, number];
  };
  geometry?: { type: string; coordinates?: [number, number] };
}

/** Average hexagon area per display resolution, km² (H3). */
const HEX_KM2: Record<number, number> = { 2: 86_745, 3: 12_393, 4: 1_770, 5: 253 };

/**
 * Which display resolution to open for a result. Settlements and anything smaller get the finest hex;
 * administrative areas get a hex roughly their size; other features (lakes, parks, mountains) are
 * sized by their extent. Always one hexagon, never several.
 */
export function resolutionFor(f: PhotonFeature['properties']): 2 | 3 | 4 | 5 {
  switch (f.type) {
    case 'country': return 2;
    case 'state': return 3;
    case 'county': return 4;
    case 'house': case 'street': case 'locality': case 'district': case 'city': return 5;
  }
  const area = extentKm2(f.extent);
  if (area === null) return 5;
  // The finest hexagon at least about half the feature's size, so most of it fits in view.
  for (const res of [5, 4, 3] as const) if (HEX_KM2[res]! >= area / 2) return res;
  return 2;
}

function extentKm2(extent: PhotonFeature['properties']['extent']): number | null {
  if (!extent || extent.length !== 4 || extent.some((v) => !Number.isFinite(v))) return null;
  const [minLon, maxLat, maxLon, minLat] = extent;
  const midLat = ((maxLat + minLat) / 2) * (Math.PI / 180);
  const km = 111.32;
  return Math.abs(maxLon - minLon) * km * Math.cos(midLat) * Math.abs(maxLat - minLat) * km;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** Turns geocoder results into places with their hexagon, dropping unusable ones and duplicates. */
export function toPlaces(features: PhotonFeature[]): Place[] {
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const f of features) {
    const p = f.properties;
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (!p.name || typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const cell = cellAt(lat, lng, resolutionFor(p));
    const detail = [...new Set([p.city, p.county, p.state, p.country].filter((v): v is string => !!v && v !== p.name))].join(', ');
    const key = `${p.name}|${detail}|${cell}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // "City", "Town", "Village"… for settlements; the feature's own kind ("Lake", "University") otherwise.
    const kind = p.type === 'country' || p.type === 'state' || p.type === 'county' ? p.type : p.osm_value ?? p.type ?? '';
    places.push({ name: p.name, detail, kind: capitalise(kind), lat, lng, cell });
  }
  return places;
}

export const PLACE_LANGUAGES = ['en', 'de', 'fr', 'it'] as const;

/** Asks the geocoder. Throws on any failure; the caller turns that into a safe message. */
export async function searchPlaces(
  baseUrl: string,
  query: string,
  lang: (typeof PLACE_LANGUAGES)[number] | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Place[]> {
  const url = new URL('/api/', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '8');
  if (lang) url.searchParams.set('lang', lang);
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'Hexstory place search (https://www.hexstory.wiki)', accept: 'application/json' },
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
  const body = (await res.json()) as { features?: PhotonFeature[] };
  return toPlaces(Array.isArray(body.features) ? body.features : []).slice(0, 6);
}
