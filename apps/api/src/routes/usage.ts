import type { FastifyPluginAsync } from 'fastify';
import { TRUST } from '@hexstory/shared';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Sql } from '../db.js';
import { requireTrust } from '../http.js';
import { createUsageService, type UsageServiceDeps } from '../usage/service.js';

/** Moderators' resource usage dashboard. Provider calls happen only here, on the server. */
export const usageRoutes =
  (deps: { config: Config; sql: Sql; coordinator: Coordinator; fetch?: UsageServiceDeps['fetch'] }): FastifyPluginAsync =>
  async (app) => {
    const usage = createUsageService({ ...deps, log: (msg, err) => app.log.warn({ err }, msg) });

    app.get('/api/moderation/usage', async (req, reply) => {
      requireTrust(req, TRUST.MODERATOR);
      reply.header('cache-control', 'no-store');
      return usage.report();
    });

    app.post('/api/moderation/usage/refresh', async (req, reply) => {
      requireTrust(req, TRUST.MODERATOR);
      reply.header('cache-control', 'no-store');
      const result = await usage.refresh();
      if (!result.ok) {
        const seconds = Math.max(1, Math.ceil((Date.parse(result.retryAt) - Date.now()) / 1000));
        return reply
          .code(429)
          .header('retry-after', String(seconds))
          .send({
            error: 'rate-limited',
            message: `Usage was refreshed less than a minute ago. Try again in ${seconds} s.`,
            retryAt: result.retryAt,
          });
      }
      return result.report;
    });
  };
