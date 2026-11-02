import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TRUST } from '@hexstory/shared';
import { forbidden } from '../errors.js';
import { parse, requireTrust, requireUser, requireWriter } from '../http.js';
import { canReview } from '../policy.js';
import {
  auditLog,
  banRequestQueue,
  declineBanRequests,
  deleteUser,
  getUserProfile,
  listUsers,
  requestBan,
  setBanned,
  setTrustLevel,
} from '../services/moderation.js';
import { revisionsBy, storiesStartedBy } from '../services/stories.js';
import type { Deps } from './deps.js';

const idParams = z.object({ id: z.uuid() });
const offsetQuery = z.object({ offset: z.coerce.number().int().min(0).max(100_000).default(0) });
const reason = z.string().trim().max(500).nullish();
const level = z.coerce.number().int().min(0).max(3);

export const userRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { sql } = deps;
    const admins = deps.config.ADMIN_EMAILS;

    // ---- User pages: public basics; contributions for the user themself and reviewers ----

    app.get('/api/users/:id', async (req) => {
      const { id } = parse(idParams, req.params);
      return getUserProfile(sql, req.user, id);
    });

    const assertCanSeeContributions = (viewer: { id: string; trustLevel: number }, userId: string) => {
      if (viewer.id !== userId && !canReview(viewer.trustLevel)) throw forbidden('Only reviewers can see other people’s contributions.');
    };

    app.get('/api/users/:id/stories', async (req) => {
      const viewer = requireUser(req);
      const { id } = parse(idParams, req.params);
      assertCanSeeContributions(viewer, id);
      return storiesStartedBy(deps, id, parse(offsetQuery, req.query).offset, canReview(viewer.trustLevel));
    });

    app.get('/api/users/:id/revisions', async (req) => {
      const viewer = requireUser(req);
      const { id } = parse(idParams, req.params);
      assertCanSeeContributions(viewer, id);
      return revisionsBy(sql, id, parse(offsetQuery, req.query).offset, canReview(viewer.trustLevel));
    });

    // ---- Reviewers ask for bans; moderators decide ----

    app.post('/api/users/:id/ban-requests', async (req, reply) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reason: z.string().trim().min(5, 'Tell moderators why (at least a few words).').max(500) }), req.body);
      await requestBan(sql, user, id, body.reason, admins);
      return reply.code(201).send({ ok: true });
    });

    app.post('/api/users/:id/ban-requests/decline', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reason }), req.body ?? {});
      await declineBanRequests(sql, user, id, body.reason ?? null);
      return { ok: true };
    });

    app.post('/api/users/:id/ban', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ banned: z.boolean(), reason, removeContent: z.boolean().default(false) }), req.body);
      const { cleanup } = await setBanned(sql, user, id, { banned: body.banned, reason: body.reason ?? null, removeContent: body.removeContent }, admins);
      return { ok: true, cleanup };
    });

    app.post('/api/users/:id/delete', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reason, removeContent: z.boolean() }), req.body);
      const { cleanup } = await deleteUser(sql, user, id, { reason: body.reason ?? null, removeContent: body.removeContent }, admins);
      return { ok: true, cleanup };
    });

    app.post('/api/users/:id/trust', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(
        z.object({ level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal('auto')]), reason }),
        req.body,
      );
      await setTrustLevel(sql, user, id, body.level, body.reason ?? null, admins);
      return { ok: true };
    });

    // ---- Moderators' screens ----

    app.get('/api/moderation/users', async (req) => {
      const user = requireTrust(req, TRUST.MODERATOR);
      const query = parse(
        offsetQuery.extend({
          q: z.string().trim().max(64).optional(),
          level: level.optional(),
          filter: z.enum(['all', 'banned', 'requested', 'reported']).default('all'),
        }),
        req.query,
      );
      return listUsers(sql, user, { ...query, level: query.level as 0 | 1 | 2 | 3 | undefined });
    });

    app.get('/api/moderation/ban-requests', async (req) => {
      const user = requireTrust(req, TRUST.MODERATOR);
      return banRequestQueue(sql, user);
    });

    app.get('/api/moderation/log', async (req) => {
      const user = requireTrust(req, TRUST.MODERATOR);
      const query = parse(
        offsetQuery.extend({
          actorId: z.uuid().optional(),
          targetType: z.enum(['story', 'revision', 'comment', 'user', 'report', 'settings', 'development', 'correction', 'collection']).optional(),
          targetId: z.string().max(64).optional(),
          action: z.string().regex(/^[a-z:-]{1,40}$/).optional(),
        }),
        req.query,
      );
      return auditLog(sql, user, query);
    });
  };
