import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { getResolution } from 'h3-js';
import { loadConfig } from '../src/config.js';
import { createMemoryCoordinator } from '../src/coordination.js';
import { placeRoutes } from '../src/routes/places.js';
import { resolutionFor, toPlaces, type PhotonFeature } from '../src/services/places.js';

const feature = (properties: PhotonFeature['properties'], coordinates: [number, number] = [-74.047455, 40.7215682]): PhotonFeature => ({
  properties,
  geometry: { type: 'Point', coordinates },
});

// Shapes taken from real Photon answers (2026-11-01).
const JERSEY_CITY = feature({
  name: 'Jersey City', type: 'city', osm_key: 'place', osm_value: 'city', county: 'Hudson', state: 'New Jersey', country: 'United States',
  extent: [-74.1166865, 40.7689376, -74.0206386, 40.661622],
});
const FRANCE = feature({ name: 'France', type: 'country', osm_key: 'place', osm_value: 'country', extent: [-178.39, 51.31, 172.31, -50.22] }, [2.21, 46.6]);

describe('place search', () => {
  it('opens the finest hexagon for a town or city, and one large hexagon for a country', () => {
    const [jc] = toPlaces([JERSEY_CITY]);
    expect(jc).toMatchObject({ name: 'Jersey City', kind: 'City', detail: 'Hudson, New Jersey, United States' });
    expect(getResolution(jc!.cell)).toBe(5);
    const [fr] = toPlaces([FRANCE]);
    expect(fr).toMatchObject({ name: 'France', kind: 'Country' });
    expect(getResolution(fr!.cell)).toBe(2);
  });

  it('sizes regions and other features sensibly', () => {
    expect(resolutionFor({ type: 'state' })).toBe(3);
    expect(resolutionFor({ type: 'county' })).toBe(4);
    // A large lake (~60,000 km²) gets a big hexagon; a small park the finest.
    expect(resolutionFor({ type: 'other', extent: [-88, 46, -84.5, 41.6] })).toBeLessThanOrEqual(3);
    expect(resolutionFor({ type: 'other', extent: [-74.06, 40.75, -74.05, 40.74] })).toBe(5);
    expect(resolutionFor({ type: 'other' })).toBe(5);
  });

  it('drops results without a name or a usable point, and duplicates', () => {
    const places = toPlaces([JERSEY_CITY, JERSEY_CITY, feature({ type: 'city' }), { properties: { name: 'Nowhere' } }, feature({ name: 'Bad' }, [500, 20])]);
    expect(places.map((p) => p.name)).toEqual(['Jersey City']);
  });

  it('proxies the geocoder with a timeout-safe error, caches results, and validates input', async () => {
    let calls = 0;
    const fakeFetch = (async (url: URL) => {
      calls++;
      if (url.searchParams.get('q') === 'broken') return new Response('nope', { status: 503 });
      expect(url.searchParams.get('limit')).toBe('8');
      return Response.json({ type: 'FeatureCollection', features: [JERSEY_CITY] });
    }) as unknown as typeof fetch;
    const app = Fastify();
    app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => reply.code(err.statusCode ?? 500).send({ message: err.message }));
    await app.register(placeRoutes({ config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x@localhost/x', APP_ORIGIN: 'http://localhost:5173' }), coordinator: createMemoryCoordinator(), fetch: fakeFetch }));

    const first = await app.inject({ url: '/api/places?q=jersey%20city' });
    expect(first.statusCode).toBe(200);
    expect(first.json()[0]).toMatchObject({ name: 'Jersey City' });
    await app.inject({ url: '/api/places?q=Jersey%20%20City' });
    expect(calls).toBe(1);

    expect((await app.inject({ url: '/api/places?q=j' })).statusCode).toBe(400);
    const down = await app.inject({ url: '/api/places?q=broken' });
    expect(down.statusCode).toBe(502);
    expect(down.json().message).not.toMatch(/503|nope/);
    await app.close();
  });
});
