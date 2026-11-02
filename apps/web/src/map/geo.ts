import { cellToChildren, getRes0Cells, polygonToCells } from 'h3-js';
import type { FeatureCollection, Point, Polygon } from 'geojson';
import { cellRing } from '@hexstory/shared';

export type CellFeatures = FeatureCollection<Polygon, { cell: string; count?: number; color?: string }>;
export type PointFeatures<P extends object = Record<string, unknown>> = FeatureCollection<Point, P>;

/** GeoJSON points ([lng, lat]) with whatever properties the layer styles read. */
export function pointsToFeatures<T extends { lat: number; lng: number }, P extends object>(
  items: readonly T[],
  props: (item: T) => P,
): PointFeatures<P> {
  return {
    type: 'FeatureCollection',
    features: items.map((item) => ({
      type: 'Feature',
      properties: props(item),
      geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
    })),
  };
}

export function cellsToFeatures(cells: Iterable<string>, counts?: Map<string, number>, colors?: Map<string, string>): CellFeatures {
  const features: CellFeatures['features'] = [];
  for (const cell of cells) {
    features.push({
      type: 'Feature',
      properties: { cell, count: counts?.get(cell), color: colors?.get(cell) },
      geometry: { type: 'Polygon', coordinates: [cellRing(cell)] },
    });
  }
  return { type: 'FeatureCollection', features };
}

let worldGrid: string[] | null = null;
/** All ~5,900 resolution-2 cells; drawn as the faint globe-wide grid when zoomed out. */
function res2Cells(): string[] {
  worldGrid ??= getRes0Cells().flatMap((c) => cellToChildren(c, 2));
  return worldGrid;
}

const MAX_GRID_CELLS = 8_000;

/** Cells to outline for the current viewport, or [] when there would be too many to draw usefully. */
export function gridCells(
  res: number,
  bounds: { west: number; east: number; south: number; north: number },
): string[] {
  if (res === 2) return res2Cells();
  const padX = (bounds.east - bounds.west) * 0.1;
  const padY = (bounds.north - bounds.south) * 0.1;
  let west = bounds.west - padX;
  let east = bounds.east + padX;
  const south = Math.max(bounds.south - padY, -85);
  const north = Math.min(bounds.north + padY, 85);
  if (east - west >= 180) return [];

  // Bring the box into [-180, 180) and split it where it crosses the antimeridian.
  const shift = Math.floor((west + 180) / 360) * 360;
  west -= shift;
  east -= shift;
  const boxes = east > 180 ? [[west, 180], [-180, east - 360]] : [[west, east]];

  const cells: string[] = [];
  for (const [w, e] of boxes as [number, number][]) {
    const ring = [[w, south], [e, south], [e, north], [w, north], [w, south]];
    cells.push(...polygonToCells([ring], res, true));
    if (cells.length > MAX_GRID_CELLS) return [];
  }
  return cells;
}

/** Bounding box of a set of cells as [[west, south], [east, north]]. */
export function cellsBounds(cells: string[]): [[number, number], [number, number]] | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const cell of cells) {
    for (const [lng, lat] of cellRing(cell)) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}
