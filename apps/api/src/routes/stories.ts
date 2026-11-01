import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createStorySchema, editStorySchema } from '@hexstory/shared';
import { parse, requireWriter } from '../http.js';
import {
  createStory,
  editStory,
  getRevision,
  getStory,
  listRevisions,
  restoreRevision,
  reviewRevision,
  setProtection,
  setRevisionRemoved,
  setStoryStatus,
} from '../services/stories.js';
import type { Deps } from './deps.js';

const idParams = z.object({ id: z.uuid() });
const reason = z.string().trim().max(500).nullish();

export const storyRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { sql } = deps;

    app.get('/api/stories/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      return getStory(deps, id, req.user);
    });

    app.post('/api/stories', async (req, reply) => {
      const user = requireWriter(req);
      const result = await createStory(deps, user, parse(createStorySchema, req.body));
      return reply.code(201).send(result);
    });

    app.put('/api/stories/:id', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      return editStory(deps, user, id, parse(editStorySchema, req.body));
    });

    app.get('/api/stories/:id/revisions', async (req) => {
      const { id } = parse(idParams, req.params);
      return listRevisions(sql, id, req.user);
    });

    app.get('/api/revisions/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      return getRevision(deps, id, req.user);
    });

    app.post('/api/revisions/:id/review', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ decision: z.enum(['accept', 'reject']), reason }), req.body);
      await reviewRevision(sql, user, id, body.decision, body.reason ?? null);
      return { ok: true };
    });

    app.post('/api/revisions/:id/removed', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ removed: z.boolean(), reason }), req.body);
      await setRevisionRemoved(sql, user, id, body.removed, body.reason ?? null);
      return { ok: true };
    });

    app.post('/api/stories/:id/restore', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const { revisionId, baseRevisionId } = parse(z.object({ revisionId: z.uuid(), baseRevisionId: z.uuid().nullish() }), req.body);
      return restoreRevision(deps, user, id, revisionId, baseRevisionId);
    });

    app.post('/api/stories/:id/status', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ status: z.enum(['active', 'hidden']), reason, revisionId: z.uuid().nullish() }), req.body);
      const status = await setStoryStatus(sql, user, id, body.status, body.reason ?? null, body.revisionId);
      return { ok: true, status };
    });

    app.post('/api/stories/:id/protection', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const { level, reason: why } = parse(z.object({ level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), reason }), req.body);
      await setProtection(sql, user, id, level, why ?? null);
      return { ok: true };
    });
  };
