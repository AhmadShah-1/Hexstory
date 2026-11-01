import type { FastifyPluginAsync } from 'fastify';
import { updateProfileSchema, type SessionInfo } from '@hexstory/shared';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { isGoogleConfigured } from '../config.js';
import { parse, requireUser } from '../http.js';
import { deleteAccount, toMe, updateProfile } from '../services/users.js';
import type { Deps } from './deps.js';

export const sessionRoutes =
  ({ sql, config }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.get('/api/session', async (req): Promise<SessionInfo> => ({
      user: req.user ? toMe(req.user) : null,
      signInEnabled: isGoogleConfigured(config),
    }));

    app.patch('/api/me', async (req) => {
      const user = requireUser(req);
      await updateProfile(sql, user.id, parse(updateProfileSchema, req.body));
      return { ok: true };
    });

    app.delete('/api/me', async (req, reply) => {
      const user = requireUser(req);
      await deleteAccount(sql, user.id);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });
  };
