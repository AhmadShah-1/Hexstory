import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre locates its worker relative to its own module, which bundlers relocate; point at it explicitly.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useNavigate } from 'react-router';
import { cellAt, compact, periodOf, resForZoom, type Category, type DisplayRes, type MapPoint } from '@hexstory/shared';
import { useMapPoints } from '../api/queries';
import { MAP_STYLE_URL } from '../features';
import { useToast } from '../components/Toast';
import { densityBin, filterPoints } from '../lib/discover';
import { CATEGORY_COLORS, DENSITY_RAMP, DEVELOPING_COLOR, EVENT_COLOR, PERIOD_COLORS, UNCATEGORISED_COLOR } from '../lib/palette';
import { cellsToFeatures, gridCells, pointsToFeatures, type CellFeatures } from './geo';
import { isNarrowScreen, useMapState, type MapLayer } from './MapContext';

maplibregl.setWorkerUrl(mapWorkerUrl);

const EMPTY: CellFeatures = { type: 'FeatureCollection', features: [] };
const COLORS = {
  grid: '#7c746c',
  focus: '#1d4ed8',
  ink: '#1c1917',
  pin: '#c2410c',
};

/** Dots grow a little as you zoom in, so dense areas stay readable from afar and tappable up close. */
const DOT_RADIUS: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 1, 2.6, 4, 4, 8, 6.5];

/** Adds our sources and layers beneath the basemap's labels so place names stay readable. */
function addLayers(map: MapLibreMap) {
  const beforeId = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
  for (const id of ['grid', 'density', 'story', 'selection', 'active', 'hover', 'points', 'markers', 'story-point', 'edit-point']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  const add = (layer: maplibregl.AddLayerObject) => map.addLayer(layer, beforeId);

  add({ id: 'grid-line', type: 'line', source: 'grid', paint: { 'line-color': COLORS.grid, 'line-opacity': 0.16, 'line-width': 0.6 } });
  add({ id: 'density-fill', type: 'fill', source: 'density', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.62 } });
  add({ id: 'density-line', type: 'line', source: 'density', paint: { 'line-color': '#57534e', 'line-opacity': 0.35, 'line-width': 0.8 } });
  add({ id: 'story-fill', type: 'fill', source: 'story', paint: { 'fill-color': COLORS.focus, 'fill-opacity': 0.14 } });
  add({ id: 'story-line', type: 'line', source: 'story', paint: { 'line-color': COLORS.focus, 'line-width': 1.4 } });
  add({ id: 'selection-fill', type: 'fill', source: 'selection', paint: { 'fill-color': COLORS.focus, 'fill-opacity': 0.3 } });
  add({ id: 'selection-line', type: 'line', source: 'selection', paint: { 'line-color': COLORS.focus, 'line-width': 1.6 } });
  add({ id: 'active-line', type: 'line', source: 'active', paint: { 'line-color': COLORS.ink, 'line-width': 2.4 } });
  add({ id: 'hover-line', type: 'line', source: 'hover', paint: { 'line-color': COLORS.ink, 'line-opacity': 0.45, 'line-width': 1.4 } });
  // A soft halo marks developing events (only drawn on the "developing" layer).
  add({
    id: 'points-halo',
    type: 'circle',
    source: 'points',
    filter: ['==', ['get', 'halo'], true],
    paint: {
      'circle-color': DEVELOPING_COLOR,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 7, 8, 14],
      'circle-opacity': ['*', 0.18, ['get', 'opacity']],
      'circle-blur': 0.6,
    },
  });
  add({
    id: 'points-circle',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': DOT_RADIUS,
      'circle-opacity': ['get', 'opacity'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
      'circle-stroke-opacity': ['get', 'opacity'],
    },
  });
  add({
    id: 'markers-circle',
    type: 'circle',
    source: 'markers',
    paint: { 'circle-color': '#ffffff', 'circle-radius': 5, 'circle-stroke-color': COLORS.focus, 'circle-stroke-width': 2 },
  });
  add({
    id: 'story-point-circle',
    type: 'circle',
    source: 'story-point',
    paint: { 'circle-color': COLORS.focus, 'circle-radius': 7.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
  });
  add({
    id: 'edit-point-circle',
    type: 'circle',
    source: 'edit-point',
    paint: { 'circle-color': COLORS.pin, 'circle-radius': 8.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 },
  });
}

function setData(map: MapLibreMap | null, source: string, data: GeoJSON.FeatureCollection) {
  (map?.getSource(source) as GeoJSONSource | undefined)?.setData(data);
}

/** The colour of one story's dot on each layer. */
function dotColor(p: MapPoint, layer: MapLayer, shown: readonly Category[]): string {
  if (layer === 'category') {
    // With a category filter on, colour by a category being shown, not one that was filtered out.
    const c = shown.length ? p.categories.find((x) => shown.includes(x)) : p.categories[0];
    return c ? CATEGORY_COLORS[c] : UNCATEGORISED_COLOR;
  }
  if (layer === 'period') return PERIOD_COLORS[periodOf(p.year)];
  if (layer === 'developing') return DEVELOPING_COLOR;
  return EVENT_COLOR;
}

/** Layers that clicks and hovers treat as stories. */
const STORY_LAYERS = ['points-circle'];
const TOOLTIP_LAYERS = ['points-circle', 'markers-circle'];

/**
 * The full-screen globe. Every published story is a dot (or, on the density layer, counted into its
 * hexagon), filtered by time and category in the browser. Clicking a dot opens the story; clicking
 * anywhere else opens that region. While writing (select mode) clicks place the story's point or pick
 * its area instead.
 */
export function WorldMap() {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [res, setRes] = useState<DisplayRes>(2);
  const state = useMapState();
  const navigate = useNavigate();
  const toast = useToast();
  const points = useMapPoints();

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
    const tooltip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'map-tooltip', maxWidth: '260px' });

    const refreshGrid = () => {
      const r = resForZoom(m.getZoom());
      setRes(r);
      const b = m.getBounds();
      setData(m, 'grid', cellsToFeatures(gridCells(r, { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() })));
    };

    m.on('style.load', () => {
      m.setProjection({ type: 'globe' });
      addLayers(m);
      refreshGrid();
      setMap(m);
      latest.current.state.registerMap(m);
    });
    m.on('moveend', refreshGrid);

    /** Story dots (or development markers) under the pointer, with a few pixels' tolerance for fingers. */
    const featuresAt = (point: maplibregl.Point, layers: string[]) => {
      const present = layers.filter((l) => m.getLayer(l));
      if (!present.length) return [];
      const pad = 5;
      return m.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: present });
    };

    let hovered: string | null = null;
    m.on('mousemove', (e) => {
      const over = latest.current.state.mode === 'browse' ? featuresAt(e.point, TOOLTIP_LAYERS)[0] : undefined;
      const title = over?.properties?.title as string | undefined;
      if (title) {
        tooltip.setLngLat(e.lngLat).setText(title).addTo(m);
        m.getCanvas().style.cursor = 'pointer';
      } else {
        tooltip.remove();
        m.getCanvas().style.cursor = latest.current.state.mode === 'select' ? 'crosshair' : 'pointer';
      }
      const { lat, lng } = e.lngLat.wrap();
      const cell = cellAt(lat, lng, latest.current.res);
      if (cell === hovered) return;
      hovered = cell;
      setData(m, 'hover', cellsToFeatures([cell]));
    });
    m.on('mouseout', () => {
      hovered = null;
      tooltip.remove();
      setData(m, 'hover', EMPTY);
    });

    m.on('click', (e) => {
      const { state, navigate, res, toast } = latest.current;
      const { lat, lng } = e.lngLat.wrap();
      if (state.mode === 'select') {
        if (state.tool === 'point') {
          state.setPoint({ lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 });
          return;
        }
        if (!state.toggleCell(cellAt(lat, lng, res))) toast('That area is too large. Zoom in and pick smaller regions.');
        return;
      }
      tooltip.remove();
      const story = featuresAt(e.point, STORY_LAYERS)[0];
      const id = story?.properties?.id as string | undefined;
      if (id) navigate(`/s/${id}`);
      else navigate(`/h/${cellAt(lat, lng, res)}`);
    });

    return () => {
      latest.current.state.registerMap(null);
      tooltip.remove();
      m.remove();
    };
  }, []);

  const { layer, filters, highlight } = state;
  const visible = useMemo(() => {
    const all = filterPoints(points.data ?? [], filters);
    return layer === 'developing' ? all.filter((p) => p.developing) : all;
  }, [points.data, filters, layer]);

  // Dots: hidden on the density layer, where the hexagons carry the information.
  const pointFeatures = useMemo(() => {
    if (layer === 'density') return EMPTY;
    const lit = highlight ? new Set(highlight) : null;
    // Highlighted stories are drawn last, on top of the faded rest.
    const ordered = lit ? [...visible].sort((a, b) => Number(lit.has(a.id)) - Number(lit.has(b.id))) : visible;
    return pointsToFeatures(ordered, (p) => ({
      id: p.id,
      title: p.title,
      color: dotColor(p, layer, filters.categories),
      opacity: !lit || lit.has(p.id) ? 0.92 : 0.14,
      halo: layer === 'developing',
    }));
  }, [visible, layer, highlight]);

  // Density: stories per hexagon at the zoom's resolution, in a few neutral bins.
  const densityFeatures = useMemo(() => {
    if (layer !== 'density') return EMPTY;
    const counts = new Map<string, number>();
    for (const p of visible) {
      const cell = cellAt(p.lat, p.lng, res);
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
    const colors = new Map([...counts].map(([cell, n]) => [cell, DENSITY_RAMP[densityBin(n)]!]));
    return cellsToFeatures(counts.keys(), counts, colors);
  }, [visible, layer, res]);

  useEffect(() => setData(map, 'points', pointFeatures), [map, pointFeatures]);
  useEffect(() => setData(map, 'density', densityFeatures), [map, densityFeatures]);
  useEffect(() => setData(map, 'story', cellsToFeatures(state.storyCells)), [map, state.storyCells]);
  useEffect(() => setData(map, 'active', cellsToFeatures(state.activeCell ? [state.activeCell] : [])), [map, state.activeCell]);
  useEffect(() => setData(map, 'selection', cellsToFeatures(compact([...state.selection]))), [map, state.selection]);
  useEffect(
    () => setData(map, 'story-point', pointsToFeatures(state.storyPoint ? [state.storyPoint] : [], () => ({}))),
    [map, state.storyPoint],
  );
  useEffect(() => setData(map, 'markers', pointsToFeatures(state.markers, (m) => ({ id: m.id, title: m.label }))), [map, state.markers]);
  useEffect(
    () => setData(map, 'edit-point', pointsToFeatures(state.mode === 'select' && state.point ? [state.point] : [], () => ({}))),
    [map, state.mode, state.point],
  );

  return <div ref={container} className="world-map" aria-label="World map of historical events. Each dot is a story." />;
}
