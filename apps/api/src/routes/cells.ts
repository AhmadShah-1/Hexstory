import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DISPLAY_RESOLUTIONS, isDisplayCell } from '@hexstory/shared';
import { parse } from '../http.js';
import { recentMessages } from '../services/square.js';
import { cellCounts, listStoriesInCell } from '../services/stories.js';
import type { Deps } from './deps.js';

const cellParams = z.object({ cell: z.string().refine(isDisplayCell, 'Invalid region') });

export const cellRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/cells', async (req) => {
      const { res } = parse(
        z.object({ res: z.coerce.number().refine((r) => (DISPLAY_RESOLUTIONS as readonly number[]).includes(r)) }),
        req.query,
      );
      return cellCounts(deps.sql, res);
    });

    app.get('/api/cells/:cell/stories', async (req) => {
      const { cell } = parse(cellParams, req.params);
      const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0).max(10_000).default(0) }), req.query);
      return listStoriesInCell(deps, cell, offset);
    });

    app.get('/api/cells/:cell/messages', async (req) => {
      const { cell } = parse(cellParams, req.params);
      return recentMessages(deps.sql, cell);
    });
  };
