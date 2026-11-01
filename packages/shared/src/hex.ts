import {
  cellToBoundary,
  cellToChildren,
  cellToLatLng,
  cellToParent,
  compactCells,
  getResolution,
  isValidCell,
  latLngToCell,
  uncompactCells,
} from 'h3-js';

/**
 * Stories are stored at BASE_RES. The map shows coarser resolutions when zoomed out;
 * every base cell is also indexed under its parents so any zoom level can be queried directly.
 * Res 5 hexes are ~250 km² (roughly a city district to a small city).
 */
export const BASE_RES = 5;
export const DISPLAY_RESOLUTIONS = [2, 3, 4, 5] as const;
export type DisplayRes = (typeof DISPLAY_RESOLUTIONS)[number];

export function resForZoom(zoom: number): DisplayRes {
  if (zoom < 3.5) return 2;
  if (zoom < 5) return 3;
  if (zoom < 6.5) return 4;
  return 5;
}

export function isDisplayCell(cell: string): boolean {
  return isValidCell(cell) && (DISPLAY_RESOLUTIONS as readonly number[]).includes(getResolution(cell));
}

/**
 * How many base cells a set of cells covers, computed without expanding them.
 * Check this before calling toBaseCells on untrusted input: expansion is exponential in resolution.
 */
export function baseCellCount(cells: readonly string[]): number {
  let total = 0;
  for (const cell of new Set(cells)) {
    const res = getResolution(cell);
    total += res < BASE_RES ? 7 ** (BASE_RES - res) : 1;
  }
  return total;
}

/** Expands any mix of display-resolution cells into the set of base cells they cover. */
export function toBaseCells(cells: readonly string[]): string[] {
  const out = new Set<string>();
  for (const cell of cells) {
    const res = getResolution(cell);
    if (res === BASE_RES) out.add(cell);
    else if (res < BASE_RES) for (const child of cellToChildren(cell, BASE_RES)) out.add(child);
    else out.add(cellToParent(cell, BASE_RES));
  }
  return [...out];
}

/** Smallest equivalent representation of a base-cell set (what revisions store). */
export function compact(baseCells: readonly string[]): string[] {
  return compactCells([...baseCells]);
}

export function uncompact(cells: readonly string[]): string[] {
  return uncompactCells([...cells], BASE_RES);
}

/** Every display cell (base cells plus their parents) a set of base cells touches. */
export function indexCells(baseCells: readonly string[]): { res: number; cell: string }[] {
  const out = new Map<string, number>();
  for (const base of baseCells) {
    for (const res of DISPLAY_RESOLUTIONS) {
      const cell = res === BASE_RES ? base : cellToParent(base, res);
      out.set(cell, res);
    }
  }
  return [...out].map(([cell, res]) => ({ cell, res }));
}

export function cellAt(lat: number, lng: number, res: number): string {
  return latLngToCell(lat, lng, res);
}

export function cellCenter(cell: string): { lat: number; lng: number } {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}

/**
 * GeoJSON ring ([lng, lat]) for a cell. Longitudes are unwrapped so cells crossing the
 * antimeridian stay contiguous instead of stretching across the whole map.
 */
export function cellRing(cell: string): [number, number][] {
  const ring = cellToBoundary(cell, true) as [number, number][];
  const first = ring[0]![0];
  const unwrapped = ring.map(([lng, lat]): [number, number] => {
    if (lng - first > 180) return [lng - 360, lat];
    if (first - lng > 180) return [lng + 360, lat];
    return [lng, lat];
  });
  unwrapped.push(unwrapped[0]!);
  return unwrapped;
}

export function formatCellLocation(cell: string): string {
  const { lat, lng } = cellCenter(cell);
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lng).toFixed(1)}°${ew}`;
}
