import type { FastifyPluginAsync } from 'fastify';
import type { SupportLinks } from '@hexstory/shared';
import type { Config } from '../config.js';

/**
 * Public links for the Support page. Read from STRIPE_SUPPORT_URL / PAYPAL_SUPPORT_URL at startup
 * (validated in config.ts), so changing them needs a restart/redeploy but no frontend rebuild.
 * Hexstory never processes or records payments: these are only links to provider-hosted pages.
 */
export const supportRoutes =
  ({ config }: { config: Pick<Config, 'SUPPORT'> }): FastifyPluginAsync =>
  async (app) => {
    for (const problem of config.SUPPORT.problems) app.log.warn(problem);

    app.get('/api/support', async (_req, reply): Promise<SupportLinks> => {
      reply.header('cache-control', 'public, max-age=300');
      return config.SUPPORT.links;
    });
  };
