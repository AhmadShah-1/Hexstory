import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { storyListQuerySchema } from '@hexstory/shared';
import { parse } from '../http.js';
import { discover } from '../services/discover.js';
import { listStories, mapPoints, randomStory, storySummaries } from '../services/stories.js';
import type { Deps } from './deps.js';

/**
 * Public data that is the same for every visitor is cached by the CDN (Vercel honours s-maxage), so
 * most map loads and home-page visits never reach the Function or the database.
 */
const publicCache = (reply: FastifyReply, seconds: number) =>
  reply.header('cache-control', `public, max-age=${Math.min(seconds, 30)}, s-maxage=${seconds}, stale-while-revalidate=600`);

export const discoveryRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { sql } = deps;

    /** Every published story as a point; the map filters and colours them in the browser. */
    app.get('/api/map/points', async (_req, reply) => {
      publicCache(reply, 60);
      return mapPoints(sql);
    });

    /** The home panel. `m`/`d` are the visitor's local month and day, for "On this day". */
    app.get('/api/discover', async (req, reply) => {
      const now = new Date();
      const { m, d } = parse(
        z.object({
          m: z.coerce.number().int().min(1).max(12).default(now.getUTCMonth() + 1),
          d: z.coerce.number().int().min(1).max(31).default(now.getUTCDate()),
        }),
        req.query,
      );
      publicCache(reply, 60);
      return discover(deps, { month: m, day: d });
    });

    /** Any list of published stories: explore, search, a person, on-this-day, developing events. */
    app.get('/api/stories', async (req) => listStories(deps, parse(storyListQuerySchema, req.query), req.user));

    /** Summaries for stories the browser already knows by id (e.g. the nearest ones on the map). */
    app.get('/api/stories/summaries', async (req) => {
      const { ids } = parse(
        z.object({ ids: z.string().transform((v) => [...new Set(v.split(',').filter(Boolean))]).pipe(z.array(z.uuid()).max(50)) }),
        req.query,
      );
      return storySummaries(deps, ids);
    });

    /** "Surprise me" (well-sourced or connected stories first) and "Explore a random event" (any). */
    app.get('/api/stories/random', async (req, reply) => {
      const { mode } = parse(z.object({ mode: z.enum(['surprise', 'any']).default('any') }), req.query);
      reply.header('cache-control', 'no-store');
      return { id: await randomStory(sql, mode) };
    });
  };
