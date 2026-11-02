import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isDisplayCell, storyListQuerySchema } from '@hexstory/shared';
import { parse } from '../http.js';
import { listStories } from '../services/stories.js';
import type { Deps } from './deps.js';

const cellParams = z.object({ cell: z.string().refine(isDisplayCell, 'Invalid region') });

export const cellRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    /** Stories in a region, with the same filters and orderings as every other list. */
    app.get('/api/cells/:cell/stories', async (req) => {
      const { cell } = parse(cellParams, req.params);
      return listStories(deps, { ...parse(storyListQuerySchema, req.query), cell }, req.user);
    });
  };
