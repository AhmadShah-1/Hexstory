import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { googleAuthRoutes } from './auth/google.js';
import { SESSION_COOKIE, getSessionUser } from './auth/sessions.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError, forbidden } from './errors.js';
import './http.js';
import { attachSquare } from './realtime/square.js';
import { cellRoutes } from './routes/cells.js';
import type { Deps } from './routes/deps.js';
import { moderationRoutes } from './routes/moderation.js';
import { sessionRoutes } from './routes/session.js';
import { storyRoutes } from './routes/stories.js';
import { uploadRoutes } from './routes/uploads.js';
import type { Storage } from './storage/index.js';

/** Third-party origins the browser may contact. Keep in sync with VITE_MAP_STYLE_URL in apps/web. */
const MAP_ORIGINS = ['https://tiles.openfreemap.org'];
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp({ config, sql, storage }: { config: Config; sql: Sql; storage: Storage }) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 512 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...MAP_ORIGINS],
        connectSrc: ["'self'", ...MAP_ORIGINS],
        workerSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', hook: 'preHandler' });
  await app.register(multipart);

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/auth/');
    if (!isApi) return;
    // CSRF protection: state-changing requests must come from our own pages.
    if (!SAFE_METHODS.has(req.method) && req.headers.origin !== config.APP_ORIGIN) {
      throw forbidden('Cross-site request blocked.', 'bad-origin');
    }
    req.user = await getSessionUser(sql, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        issues: (err as HttpError & { issues?: unknown }).issues,
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'request', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our side. Please try again.' });
  });

  const square = attachSquare(app.server, { sql, appOrigin: config.APP_ORIGIN });
  app.addHook('onClose', () => square.close());
  const deps: Deps = { config, sql, storage, square };

  await app.register(googleAuthRoutes({ sql, config }));
  await app.register(sessionRoutes(deps));
  await app.register(cellRoutes(deps));
  await app.register(storyRoutes(deps));
  await app.register(uploadRoutes(deps));
  await app.register(moderationRoutes(deps));

  if (storage.localDir) {
    await app.register(fastifyStatic, {
      root: storage.localDir,
      prefix: '/media/',
      decorateReply: false,
      immutable: true,
      maxAge: '365d',
    });
  }

  // In production the API also serves the built web app; in development Vite does.
  const serveWeb = config.NODE_ENV === 'production' && existsSync(WEB_DIST);
  if (serveWeb) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/', wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    const isPage = (req.method === 'GET' || req.method === 'HEAD') && !/^\/(api|auth|media|socket\.io)\//.test(req.url);
    if (serveWeb && isPage) return reply.sendFile('index.html', WEB_DIST);
    return reply.code(404).send({ error: 'not-found', message: 'Not found.' });
  });

  return app;
}
