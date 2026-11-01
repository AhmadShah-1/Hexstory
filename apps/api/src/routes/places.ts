import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Place } from '@hexstory/shared';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import { HttpError } from '../errors.js';
import { parse } from '../http.js';
import { PLACE_LANGUAGES, searchPlaces } from '../services/places.js';

const CACHE_MS = 24 * 60 * 60 * 1000;

export const placeRoutes =
  ({ config, coordinator, fetch: fetchImpl }: { config: Config; coordinator: Coordinator; fetch?: typeof fetch }): FastifyPluginAsync =>
  async (app) => {
    /**
     * Search-as-you-type for the map's search box. Public. Results are cached across instances for a
     * day (place names rarely move), and each address gets a modest per-minute allowance, which keeps
     * us well within the free geocoder's fair use.
     */
    app.get('/api/places', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply): Promise<Place[]> => {
      const { q, lang } = parse(
        z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(100), lang: z.enum(PLACE_LANGUAGES).optional() }),
        req.query,
      );
      const key = `places:${lang ?? '-'}:${q.toLowerCase().replace(/\s+/g, ' ')}`;
      const cached = await coordinator.getJson<Place[]>(key).catch(() => null);
      reply.header('cache-control', 'public, max-age=3600');
      if (cached) return cached;
      let places: Place[];
      try {
        places = await searchPlaces(config.GEOCODER_URL, q, lang, fetchImpl);
      } catch (err) {
        req.log.warn({ err }, 'place search failed');
        throw new HttpError(502, 'geocoder', "Place search isn't available right now. Try again in a moment.");
      }
      await coordinator.setJson(key, places, CACHE_MS).catch(() => {});
      return places;
    });
  };
