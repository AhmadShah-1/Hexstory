import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre locates its worker relative to its own module, which bundlers relocate; point at it explicitly.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useNavigate } from 'react-router';
import { cellAt, compact, resForZoom, type DisplayRes } from '@hexstory/shared';
import { useCellCounts } from '../api/queries';
import { MAP_STYLE_URL } from '../features';
import { useToast } from '../components/Toast';
import { cellsToFeatures, gridCells, type CellFeatures } from './geo';
import { isNarrowScreen, useMapState } from './MapContext';

maplibregl.setWorkerUrl(mapWorkerUrl);

const EMPTY: CellFeatures = { type: 'FeatureCollection', features: [] };
const COLORS = {
  grid: '#7c746c',
  occupied: '#ea580c',
  occupiedLine: '#c2410c',
  focus: '#1d4ed8',
  ink: '#1c1917',
};

/** Adds our sources and layers beneath the basemap's labels so place names stay readable. */
function addHexLayers(map: MapLibreMap) {
  const beforeId = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
  for (const id of ['grid', 'occupied', 'story', 'selection', 'active', 'hover']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  const add = (layer: maplibregl.AddLayerObject) => map.addLayer(layer, beforeId);

  add({ id: 'grid-line', type: 'line', source: 'grid', paint: { 'line-color': COLORS.grid, 'line-opacity': 0.16, 'line-width': 0.6 } });
  add({
    id: 'occupied-fill',
    type: 'fill',
    source: 'occupied',
    paint: {
      'fill-color': COLORS.occupied,
      'fill-opacity': ['interpolate', ['linear'], ['coalesce', ['get', 'count'], 1], 1, 0.42, 5, 0.55, 25, 0.68, 100, 0.8],
    },
  });
  add({ id: 'occupied-line', type: 'line', source: 'occupied', paint: { 'line-color': COLORS.occupiedLine, 'line-opacity': 0.7, 'line-width': 1 } });
  add({ id: 'story-fill', type: 'fill', source: 'story', paint: { 'fill-color': COLORS.focus, 'fill-opacity': 0.18 } });
  add({ id: 'story-line', type: 'line', source: 'story', paint: { 'line-color': COLORS.focus, 'line-width': 1.4 } });
  add({ id: 'selection-fill', type: 'fill', source: 'selection', paint: { 'fill-color': COLORS.focus, 'fill-opacity': 0.3 } });
  add({ id: 'selection-line', type: 'line', source: 'selection', paint: { 'line-color': COLORS.focus, 'line-width': 1.6 } });
  add({ id: 'active-line', type: 'line', source: 'active', paint: { 'line-color': COLORS.ink, 'line-width': 2.4 } });
  add({ id: 'hover-line', type: 'line', source: 'hover', paint: { 'line-color': COLORS.ink, 'line-opacity': 0.45, 'line-width': 1.4 } });
}

function setData(map: MapLibreMap | null, source: string, data: CellFeatures) {
  (map?.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

/**
 * The full-screen globe. It renders state from MapContext and turns clicks into either
 * navigation (browse mode) or region selection (select mode, while writing a story).
 */
export function WorldMap() {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [res, setRes] = useState<DisplayRes>(2);
  const state = useMapState();
  const navigate = useNavigate();
  const toast = useToast();
  const counts = useCellCounts(res);

  // Event handlers are registered once; they read the latest values through this ref.
  const latest = useRef({ state, navigate, res, toast });
  latest.current = { state, navigate, res, toast };

  useEffect(() => {
    const m = new maplibregl.Map({
      container: container.current!,
      style: MAP_STYLE_URL,
      center: [12, 30],
      zoom: isNarrowScreen() ? 1.1 : 2.2,
      minZoom: 0.5,
      maxZoom: 12,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    const refreshGrid = () => {
      const r = resForZoom(m.getZoom());
      setRes(r);
      const b = m.getBounds();
      setData(m, 'grid', cellsToFeatures(gridCells(r, { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() })));
    };

    m.on('style.load', () => {
      m.setProjection({ type: 'globe' });
      addHexLayers(m);
      refreshGrid();
      setMap(m);
      latest.current.state.registerMap(m);
    });
    m.on('moveend', refreshGrid);

    let hovered: string | null = null;
    m.on('mousemove', (e) => {
      const { lat, lng } = e.lngLat.wrap();
      const cell = cellAt(lat, lng, latest.current.res);
      if (cell === hovered) return;
      hovered = cell;
      setData(m, 'hover', cellsToFeatures([cell]));
      m.getCanvas().style.cursor = 'pointer';
    });
    m.on('mouseout', () => {
      hovered = null;
      setData(m, 'hover', EMPTY);
    });

    m.on('click', (e) => {
      const { state, navigate, res, toast } = latest.current;
      const { lat, lng } = e.lngLat.wrap();
      const cell = cellAt(lat, lng, res);
      if (state.mode === 'select') {
        if (!state.toggleCell(cell)) toast('That area is too large. Zoom in and pick smaller regions.');
        return;
      }
      navigate(`/h/${cell}`);
    });

    return () => {
      latest.current.state.registerMap(null);
      m.remove();
    };
  }, []);

  const countFeatures = useMemo(() => {
    const data = counts.data ?? [];
    return cellsToFeatures(
      data.map((c) => c.cell),
      new Map(data.map((c) => [c.cell, c.count])),
    );
  }, [counts.data]);

  useEffect(() => setData(map, 'occupied', countFeatures), [map, countFeatures]);
  useEffect(() => setData(map, 'story', cellsToFeatures(state.storyCells)), [map, state.storyCells]);
  useEffect(() => setData(map, 'active', cellsToFeatures(state.activeCell ? [state.activeCell] : [])), [map, state.activeCell]);
  useEffect(() => setData(map, 'selection', cellsToFeatures(compact([...state.selection]))), [map, state.selection]);

  return <div ref={container} className="world-map" aria-label="World map divided into hexagonal regions" />;
}
