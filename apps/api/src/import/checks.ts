import { readFile, writeFile } from 'node:fs/promises';
import { distanceKm } from '@hexstory/shared';
import type { Issue, ParsedRecord } from './format.js';

/**
 * Network checks for import files, cached in a JSON file next to them so repeated runs are fast:
 * - every source and photo link must exist (404/410 or an unknown domain is an error: likely invented;
 *   sites that refuse automated requests (401/403/429, timeouts) are only warnings);
 * - optionally, each place (the event's and its developments') is looked up with OpenStreetMap's Nominatim
 *   and compared with the given coordinates: a point well outside the area the geocoder knows for that
 *   place is a warning, and so is a lookup that failed (a check that didn't run never passes silently).
 */
const USER_AGENT = 'HexstoryImporter/1.0 (link check for a history site; contact hexstory.world@gmail.com)';
const CACHE_DAYS = 30;
const URL_TIMEOUT_MS = 10_000;
/** How far outside the geocoder's area for a place (its bounding box) the coordinates may be. */
const PLACE_MARGIN_KM = 10;
/** Nominatim's usage policy: at most one request per second, with a user agent that identifies us. */
const GEOCODER_GAP_MS = 1_100;
export const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org';

type UrlResult = { status: number | 'dns' | 'timeout' | 'error'; at: string };
/** `box` is [south, north, west, east]. Entries without it (older Photon results) are looked up again. */
type PlaceResult = { lat: number; lng: number; box: [number, number, number, number]; at: string } | { none: true; at: string };
interface Cache { urls: Record<string, UrlResult>; places: Record<string, PlaceResult> }

const fresh = (at: string) => Date.now() - new Date(at).getTime() < CACHE_DAYS * 86_400_000;

export async function loadCache(path: string): Promise<Cache> {
  try {
    const c = JSON.parse(await readFile(path, 'utf8')) as Cache;
    return { urls: c.urls ?? {}, places: c.places ?? {} };
  } catch {
    return { urls: {}, places: {} };
  }
}
export const saveCache = (path: string, cache: Cache) => writeFile(path, JSON.stringify(cache));

async function checkUrl(url: string): Promise<UrlResult> {
  const at = new Date().toISOString();
  const attempt = async (method: 'HEAD' | 'GET') => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' } });
      await res.body?.cancel().catch(() => {});
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await attempt('HEAD');
    // Many sites don't answer HEAD properly; ask again with GET (the body is not read).
    if (status === 405 || status === 403 || status === 404 || status >= 500) status = await attempt('GET');
    return { status, at };
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { status: 'dns', at };
    if ((err as Error).name === 'AbortError') return { status: 'timeout', at };
    return { status: 'error', at };
  }
}

/** Runs `task` over items with at most `limit` at once overall and 2 per host, to be polite. */
async function politely<T>(items: T[], hostOf: (t: T) => string, limit: number, task: (t: T) => Promise<void>) {
  const perHost = new Map<string, number>();
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const i = queue.findIndex((t) => (perHost.get(hostOf(t)) ?? 0) < 2);
      if (i < 0) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const [item] = queue.splice(i, 1);
      const host = hostOf(item!);
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      try {
        await task(item!);
      } finally {
        perHost.set(host, (perHost.get(host) ?? 1) - 1);
      }
    }
  });
  await Promise.all(workers);
}

export async function checkUrls(records: ParsedRecord[], cache: Cache, log: (msg: string) => void): Promise<Issue[]> {
  const uses = new Map<string, string[]>();
  for (const { record: r, where } of records) {
    const urls = [...r.sources.map((s) => s.url), ...r.developments.flatMap((d) => d.sources.map((s) => s.url)), ...(r.photo ? [r.photo.source] : [])];
    for (const url of urls) uses.set(url, [...(uses.get(url) ?? []), where]);
  }
  const todo = [...uses.keys()].filter((u) => !cache.urls[u] || !fresh(cache.urls[u]!.at));
  if (todo.length) log(`Checking ${todo.length} links (${uses.size - todo.length} cached)…`);
  let done = 0;
  await politely(todo, (u) => new URL(u).hostname, 8, async (url) => {
    cache.urls[url] = await checkUrl(url);
    if (++done % 200 === 0) log(`  ${done}/${todo.length}`);
  });
  const issues: Issue[] = [];
  for (const [url, wheres] of uses) {
    const { status } = cache.urls[url]!;
    const where = wheres[0]! + (wheres.length > 1 ? ` (+${wheres.length - 1} more)` : '');
    if (status === 404 || status === 410 || status === 'dns') {
      issues.push({ level: 'error', where, message: `link does not exist (${status === 'dns' ? 'unknown domain' : status}): ${url}` });
    } else if (typeof status !== 'number' || status >= 400) {
      issues.push({ level: 'warning', where, message: `could not verify link (${status}); check it by hand: ${url}` });
    }
  }
  return issues;
}

const usable = (p: PlaceResult | undefined): p is PlaceResult => !!p && fresh(p.at) && ('none' in p || Array.isArray(p.box));

/** True when the point lies inside the box widened by `marginKm` on every side. */
function insideBox(pt: { lat: number; lng: number }, [south, north, west, east]: [number, number, number, number], marginKm: number) {
  const dLat = marginKm / 111;
  const dLng = marginKm / (111 * Math.max(Math.cos((pt.lat * Math.PI) / 180), 0.01));
  const inLng = west <= east ? pt.lng >= west - dLng && pt.lng <= east + dLng : pt.lng >= west - dLng || pt.lng <= east + dLng;
  return pt.lat >= south - dLat && pt.lat <= north + dLat && inLng;
}

export async function checkPlaces(
  records: ParsedRecord[],
  cache: Cache,
  log: (msg: string) => void,
  opts: { geocoderUrl?: string; fetchImpl?: typeof fetch; gapMs?: number } = {},
): Promise<Issue[]> {
  const base = (opts.geocoderUrl ?? DEFAULT_GEOCODER_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const gapMs = opts.gapMs ?? GEOCODER_GAP_MS;
  const uses: { where: string; location: { lat: number; lng: number; place: string } }[] = [];
  for (const { record: r, where } of records) {
    uses.push({ where, location: r.location });
    r.developments.forEach((d, i) => d.location && uses.push({ where: `${where} developments.${i}`, location: d.location }));
  }
  const places = [...new Set(uses.map((u) => u.location.place))];
  const todo = places.filter((p) => !usable(cache.places[p]));
  if (todo.length) log(`Looking up ${todo.length} places (${places.length - todo.length} cached; about one a second)…`);
  const failed: string[] = [];
  let lastError = '';
  for (const [n, place] of todo.entries()) {
    if (n) await new Promise((r) => setTimeout(r, gapMs));
    const at = new Date().toISOString();
    try {
      const res = await fetchImpl(`${base}/search?format=jsonv2&limit=1&accept-language=en&q=${encodeURIComponent(place)}`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(URL_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
      const [hit] = (await res.json()) as { lat: string; lon: string; boundingbox: [string, string, string, string] }[];
      cache.places[place] = hit
        ? { lat: Number(hit.lat), lng: Number(hit.lon), box: hit.boundingbox.map(Number) as [number, number, number, number], at }
        : { none: true, at };
    } catch (err) {
      // Not cached, so the next run tries again.
      failed.push(place);
      lastError = (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message;
    }
    if ((n + 1) % 100 === 0) log(`  ${n + 1}/${todo.length}`);
  }

  const issues: Issue[] = [];
  if (failed.length) {
    issues.push({
      level: 'warning',
      where: 'place check',
      message: `${failed.length} of ${places.length} places could not be looked up (${lastError}), so their coordinates were NOT checked; run the check again later. First: ${failed.slice(0, 5).map((p) => `"${p}"`).join(', ')}`,
    });
  }
  for (const { where, location } of uses) {
    const found = cache.places[location.place];
    if (!found || failed.includes(location.place)) continue;
    if ('none' in found) {
      issues.push({ level: 'warning', where, message: `place "${location.place}" not found by the geocoder; check the coordinates by hand` });
    } else if (!insideBox(location, found.box, PLACE_MARGIN_KM)) {
      const km = Math.round(distanceKm(found, location));
      issues.push({ level: 'warning', where, message: `coordinates are ${km} km from "${location.place}" (${found.lat.toFixed(3)}, ${found.lng.toFixed(3)}), outside the area the geocoder knows for it; check them` });
    }
  }
  return issues;
}
