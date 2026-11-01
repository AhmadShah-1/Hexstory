import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TRUST, editableFrom, editableRulesSchema } from '@hexstory/shared';
import { parse, requireTrust } from '../http.js';
import { getRules, rulesUpdatedAt, updateRules } from '../services/settings.js';
import type { Deps } from './deps.js';

export const settingsRoutes =
  ({ sql }: Deps): FastifyPluginAsync =>
  async (app) => {
    /** The rules in force, for the About and account pages. Public: they describe how the site works. */
    app.get('/api/rules', async () => getRules(sql));

    app.get('/api/moderation/settings', async (req) => {
      requireTrust(req, TRUST.MODERATOR);
      return { rules: editableFrom(await getRules(sql)), updated: await rulesUpdatedAt(sql) };
    });

    app.put('/api/moderation/settings', async (req) => {
      const user = requireTrust(req, TRUST.MODERATOR);
      const body = parse(z.object({ rules: editableRulesSchema, reason: z.string().trim().max(500).nullish() }), req.body);
      const rules = await updateRules(sql, user, body.rules, body.reason ?? null);
      return { rules: editableFrom(rules), updated: await rulesUpdatedAt(sql) };
    });
  };
