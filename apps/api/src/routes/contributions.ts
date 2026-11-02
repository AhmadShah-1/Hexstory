import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { collectionSchema, COLLECTION_KINDS, createCorrectionSchema, createDevelopmentSchema, resolveCorrectionSchema } from '@hexstory/shared';
import { parse, requireWriter } from '../http.js';
import {
  createCollection,
  getCollection,
  listCollections,
  setCollectionFeatured,
  setCollectionStatus,
  updateCollection,
} from '../services/collections.js';
import { createCorrection, listCorrections, removeCorrection, resolveCorrection } from '../services/corrections.js';
import { addDevelopment, removeDevelopment, reviewDevelopment, storyDevelopments } from '../services/developments.js';
import { invalidateDiscover } from '../services/discover.js';
import type { Deps } from './deps.js';

const idParams = z.object({ id: z.uuid() });
const offsetQuery = z.object({ offset: z.coerce.number().int().min(0).max(10_000).default(0) });
const reason = z.string().trim().max(500).nullish();

/** Event timelines, corrections and collections. */
export const contributionRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { sql } = deps;

    // ---- Developments (an event's timeline) ----

    app.get('/api/stories/:id/developments', async (req) => {
      const { id } = parse(idParams, req.params);
      return storyDevelopments(deps, id, req.user, parse(offsetQuery, req.query).offset);
    });

    app.post('/api/stories/:id/developments', async (req, reply) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const result = await addDevelopment(deps, user, id, parse(createDevelopmentSchema, req.body));
      invalidateDiscover();
      return reply.code(201).send(result);
    });

    app.post('/api/developments/:id/review', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ decision: z.enum(['accept', 'reject']), reason }), req.body);
      await reviewDevelopment(sql, user, id, body.decision, body.reason ?? null);
      invalidateDiscover();
      return { ok: true };
    });

    app.post('/api/developments/:id/remove', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      await removeDevelopment(sql, user, id, parse(z.object({ reason }), req.body ?? {}).reason ?? null);
      invalidateDiscover();
      return { ok: true };
    });

    // ---- Corrections ----

    app.get('/api/stories/:id/corrections', async (req) => {
      const { id } = parse(idParams, req.params);
      return listCorrections(sql, id, req.user);
    });

    app.post('/api/stories/:id/corrections', async (req, reply) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      return reply.code(201).send(await createCorrection(sql, user, id, parse(createCorrectionSchema, req.body)));
    });

    app.post('/api/corrections/:id/resolve', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      await resolveCorrection(sql, user, id, parse(resolveCorrectionSchema, req.body));
      return { ok: true };
    });

    app.post('/api/corrections/:id/remove', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      await removeCorrection(sql, user, id, parse(z.object({ reason }), req.body ?? {}).reason ?? null);
      return { ok: true };
    });

    // ---- Collections ----

    app.get('/api/collections', async (req) => {
      const query = parse(offsetQuery.extend({ kind: z.enum(COLLECTION_KINDS).optional() }), req.query);
      return listCollections(sql, query);
    });

    app.get('/api/collections/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      return getCollection(deps, id, req.user);
    });

    app.post('/api/collections', async (req, reply) => {
      const user = requireWriter(req);
      const result = await createCollection(sql, user, parse(collectionSchema, req.body));
      invalidateDiscover();
      return reply.code(201).send(result);
    });

    app.put('/api/collections/:id', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      await updateCollection(sql, user, id, parse(collectionSchema, req.body));
      invalidateDiscover();
      return { ok: true };
    });

    app.post('/api/collections/:id/status', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ status: z.enum(['active', 'hidden']), reason }), req.body);
      await setCollectionStatus(sql, user, id, body.status, body.reason ?? null);
      invalidateDiscover();
      return { ok: true };
    });

    app.post('/api/collections/:id/featured', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      await setCollectionFeatured(sql, user, id, parse(z.object({ featured: z.boolean() }), req.body).featured);
      invalidateDiscover();
      return { ok: true };
    });
  };
