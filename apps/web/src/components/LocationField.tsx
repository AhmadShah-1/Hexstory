import { LIMITS } from '@hexstory/shared';
import { areaKm2 } from '../lib/format';
import { useMapState } from '../map/MapContext';
import { PlaceSearch } from './PlaceSearch';

export const formatLatLng = ({ lat, lng }: { lat: number; lng: number }) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;

/**
 * "Where" in the editors. The event's precise point comes from the place search or a click on the map
 * (the map is in select mode; clicks drop the pin while the tool is 'point'). Hexagons are only how the
 * map draws things, so the wider area is optional: with `area`, a toggle switches clicks to adding or
 * removing hexagons. Turning it off keeps the selection, so turning it back on restores it.
 */
export function LocationField({ placeName, onPlaceName, area, error, optional = false }: {
  placeName: string;
  /** Shown as optional (developments may have no place of their own). */
  optional?: boolean;
  onPlaceName: (name: string) => void;
  /** Omit for point-only locations (developments). */
  area?: { on: boolean; onToggle: (on: boolean) => void; error?: string };
  error?: string;
}) {
  const map = useMapState();
  const { point, tool } = map;
  const areaCount = map.selection.size;

  return (
    <fieldset className={`field location-field ${error ? 'field-error' : ''}`}>
      <legend>Where{optional && <span className="muted small"> (optional)</span>}</legend>
      <PlaceSearch
        className="place-search-inline"
        placeholder="Search for the place"
        label="Search for where it happened"
        onPick={(place) => {
          map.setTool('point');
          map.setPoint({ lat: place.lat, lng: place.lng });
          onPlaceName(place.name);
          map.focusPoints([{ lat: place.lat, lng: place.lng }], { maxZoom: 10 });
        }}
      />
      <div className="where">
        {point ? (
          <p className="location-point">
            <strong>Pin placed</strong> <span className="muted small">{formatLatLng(point)}</span>{' '}
            <button type="button" className="link-button" onClick={() => map.focusPoints([point], { maxZoom: 10 })}>Show on map</button>
            {optional && <> · <button type="button" className="link-button" onClick={() => { map.setPoint(null); onPlaceName(''); }}>Remove</button></>}
          </p>
        ) : (
          <p><strong>No place chosen yet.</strong>{optional && <span className="muted small"> Leave it empty if it happened where the story did.</span>}</p>
        )}
        <p className="muted small">
          {tool === 'point'
            ? 'Search above, or click the map exactly where it happened. Zoom in for precision.'
            : 'Click hexagons on the map to add or remove them. Zoomed out, one click covers a wide area.'}
        </p>
      </div>
      <label className="location-name">
        <span className="small">Place name</span>
        <input
          value={placeName}
          maxLength={LIMITS.placeNameMax}
          placeholder="e.g. Tahrir Square, Cairo"
          onChange={(e) => onPlaceName(e.target.value)}
        />
      </label>

      {area && (
        <>
          <label className="toggle">
            <input
              type="checkbox"
              checked={area.on}
              onChange={(e) => {
                area.onToggle(e.target.checked);
                map.setTool(e.target.checked ? 'area' : 'point');
              }}
            />
            Also mark the wider area it covers (a war, a migration, a whole city)
          </label>
          {area.on && (
            <div className="where">
              <div className="segmented" role="radiogroup" aria-label="What map clicks do">
                {(['point', 'area'] as const).map((t) => (
                  <label key={t}>
                    <input type="radio" name="map-tool" checked={tool === t} onChange={() => map.setTool(t)} />
                    {t === 'point' ? 'Move the pin' : 'Pick the area'}
                  </label>
                ))}
              </div>
              <strong>{areaCount === 0 ? 'No area selected yet' : `About ${areaKm2(areaCount)} selected`}</strong>
              {areaCount > 0 && (
                <div className="row">
                  <button type="button" className="link-button" onClick={() => map.focusCells([...map.selection])}>Show on map</button>
                  <button type="button" className="link-button" onClick={() => map.setSelection([])}>Clear</button>
                </div>
              )}
              {area.error && <p className="error-text">{area.error}</p>}
            </div>
          )}
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </fieldset>
  );
}
