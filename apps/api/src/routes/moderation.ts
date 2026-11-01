import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createReportSchema, type WatchtowerData } from '@hexstory/shared';
import { forbidden } from '../errors.js';
import { parse, requireWriter } from '../http.js';
import { canReview } from '../policy.js';
import { createReport, openReports, resolveReport } from '../services/reports.js';
import { hideMessage } from '../services/square.js';
import { pendingForReview, unreviewedStories } from '../services/stories.js';
import { setBanned } from '../services/users.js';
import type { Deps } from './deps.js';

const idParams = z.object({ id: z.uuid() });
const reason = z.string().trim().max(500).nullish();

export const moderationRoutes =
  (deps: Deps): FastifyPluginAsync =>
  async (app) => {
    const { sql, square } = deps;

    app.post('/api/reports', async (req, reply) => {
      const user = requireWriter(req);
      await createReport(sql, user, parse(createReportSchema, req.body));
      return reply.code(201).send({ ok: true });
    });

    app.get('/api/watchtower', async (req): Promise<WatchtowerData> => {
      const user = requireWriter(req);
      if (!canReview(user.trustLevel)) throw forbidden();
      const [pending, unreviewed, reports] = await Promise.all([
        pendingForReview(deps),
        unreviewedStories(deps),
        openReports(sql),
      ]);
      return { pending, unreviewed, reports };
    });

    app.post('/api/reports/:id/resolve', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const { resolution } = parse(z.object({ resolution: z.enum(['dismissed', 'actioned']) }), req.body);
      await resolveReport(sql, user, id, resolution);
      return { ok: true };
    });

    app.post('/api/messages/:id/hide', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ reason }), req.body ?? {});
      const { cell } = await hideMessage(sql, user, id, body.reason ?? null);
      square.messageHidden(cell, id);
      return { ok: true };
    });

    app.post('/api/users/:id/ban', async (req) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      const body = parse(z.object({ banned: z.boolean(), reason }), req.body);
      await setBanned(sql, user, id, body.banned, body.reason ?? null);
      return { ok: true };
    });
  };
