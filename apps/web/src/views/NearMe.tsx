import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { distanceKm } from '@hexstory/shared';
import { useMapPoints, useStorySummaries } from '../api/queries';
import { Panel } from '../components/Panel';
import { StoryRow } from '../components/StoryRow';
import { filterPoints } from '../lib/discover';
import { hasFilters, useMapState, type LatLng } from '../map/MapContext';

const NEAREST = 20;

type Status = { state: 'asking' } | { state: 'found'; at: LatLng } | { state: 'denied' } | { state: 'unavailable'; message: string };

const formatDistance = (km: number) =>
  km < 1 ? 'Less than 1 km away' : km < 10 ? `${km.toFixed(1)} km away` : `${Math.round(km).toLocaleString()} km away`;

/**
 * "History near me": the nearest published stories to the visitor. The browser's location is used only
 * here, to sort the map's points (which the browser already has); it is never sent to Hexstory.
 */
export function NearMe() {
  const [status, setStatus] = useState<Status>({ state: 'asking' });
  const points = useMapPoints();
  const { filters, setHighlight, setMarkers, focusPoints } = useMapState();

  const locate = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setStatus({ state: 'unavailable', message: "This browser can't share its location." });
      return;
    }
    setStatus({ state: 'asking' });
    navigator.geolocation.getCurrentPosition(
      (pos) => setStatus({ state: 'found', at: { lat: pos.coords.latitude, lng: pos.coords.longitude } }),
      (err) =>
        setStatus(
          err.code === err.PERMISSION_DENIED
            ? { state: 'denied' }
            : { state: 'unavailable', message: "We couldn't find your location just now." },
        ),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 },
    );
  }, []);

  // The visitor asked for this by opening the page, so ask the browser straight away.
  useEffect(locate, [locate]);

  const at = status.state === 'found' ? status.at : null;
  const nearest = useMemo(() => {
    if (!at || !points.data) return [];
    return filterPoints(points.data, filters)
      .map((p) => ({ point: p, km: distanceKm(at, p) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, NEAREST);
  }, [at, points.data, filters]);
  const ids = useMemo(() => nearest.map((n) => n.point.id), [nearest]);
  const summaries = useStorySummaries(ids);
  const distance = new Map(nearest.map((n) => [n.point.id, n.km]));

  useEffect(() => {
    if (!at) return;
    setMarkers([{ id: 'you', lat: at.lat, lng: at.lng, label: 'You are here' }]);
    setHighlight(ids);
    focusPoints([at, ...nearest.slice(0, 8).map((n) => n.point)]);
  }, [at, ids, nearest, setMarkers, setHighlight, focusPoints]);
  useEffect(
    () => () => {
      setMarkers([]);
      setHighlight(null);
    },
    [setMarkers, setHighlight],
  );

  return (
    <Panel title="History near you" subtitle="Your location stays in your browser">
      {status.state === 'asking' && (
        <p className="muted pad">Asking your browser where you are… Your location is only used here, in your browser, to sort stories by distance. It is never sent to Hexstory.</p>
      )}
      {(status.state === 'denied' || status.state === 'unavailable') && (
        <div className="empty">
          <p className="empty-title">{status.state === 'denied' ? 'Location not shared' : status.message}</p>
          <p className="muted">
            That's fine. Search for a place with the box at the top of the map, or browse instead.
          </p>
          <div className="row near-fallback">
            <button className="button" onClick={locate}>Try again</button>
            <Link className="button" to="/explore">Explore stories</Link>
          </div>
        </div>
      )}
      {at && (
        <>
          <p className="pad-x muted small">
            The nearest {nearest.length === 1 ? 'story' : `${nearest.length} stories`}
            {hasFilters(filters) ? ' matching the map filters' : ''}, closest first. Your location never leaves this browser.
          </p>
          {points.data && !nearest.length && (
            <div className="empty">
              <p className="empty-title">No stories match here yet.</p>
              <p className="muted">Know what happened around you? It could be the first story on this part of the map.</p>
              <Link className="button button-primary" to="/new">Write a story</Link>
            </div>
          )}
          {summaries.isLoading && <p className="muted pad">Loading stories…</p>}
          <div className="story-list">
            {(summaries.data ?? []).map((s) => (
              <div key={s.id} className="near-row">
                <StoryRow story={s} />
                <span className="near-distance muted small">{formatDistance(distance.get(s.id) ?? 0)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
