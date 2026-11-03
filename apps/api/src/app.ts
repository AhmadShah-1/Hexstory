import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { TRUST } from '@hexstory/shared';
import { googleAuthRoutes } from './auth/google.js';
import { SESSION_COOKIE, getSessionUser } from './auth/sessions.js';
import type { Config } from './config.js';
import type { Coordinator } from './coordination.js';
import type { Sql } from './db.js';
import { HttpError, forbidden } from './errors.js';
import { POLICY } from './policy.js';
import './http.js';
import { cellRoutes } from './routes/cells.js';
import { contributionRoutes } from './routes/contributions.js';
import { discoveryRoutes } from './routes/discovery.js';
import type { Deps } from './routes/deps.js';
import { moderationRoutes } from './routes/moderation.js';
import { sessionRoutes } from './routes/session.js';
import { settingsRoutes } from './routes/settings.js';
import { storyRoutes } from './routes/stories.js';
import { supportRoutes } from './routes/support.js';
import { uploadRoutes } from './routes/uploads.js';
import { usageRoutes } from './routes/usage.js';
import { placeRoutes } from './routes/places.js';
import { userRoutes } from './routes/users.js';
import type { Storage } from './storage/index.js';

/** Third-party origins the browser may contact. Keep in sync with VITE_MAP_STYLE_URL in apps/web. */
const MAP_ORIGINS = ['https://tiles.openfreemap.org'];
/** Microsoft Clarity (analytics, apps/web/src/lib/clarity.ts): its tag, collection endpoints and pixels. */
const CLARITY_ORIGINS = ['https://*.clarity.ms'];
const CLARITY_IMAGE_ORIGINS = [...CLARITY_ORIGINS, 'https://c.bing.com'];
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Page navigations get the SPA; API paths and anything that looks like a file get a real 404.
 * `/socket.io` was the retired Square's endpoint: old clients still asking for it get a 404, not a page.
 */
export function isPageRequest(method: string, url: string): boolean {
  const path = url.split('?')[0]!;
  return (method === 'GET' || method === 'HEAD') && !/^\/(api|auth|media|socket\.io|assets)(\/|$)/.test(path) && !/\.[a-z0-9]+$/i.test(path);
}

export async function buildApp({
  config,
  sql,
  storage,
  coordinator,
  webRoot = WEB_DIST,
}: {
  config: Config;
  sql: Sql;
  storage: Storage;
  coordinator: Coordinator;
  /** Built frontend directory; tests can supply an isolated HTML fixture. */
  webRoot?: string;
}) {
  const imageOrigins = storage.imageOrigin ? [storage.imageOrigin] : [];
  const uploadOrigins = storage.uploadOrigin ? [storage.uploadOrigin] : [];
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: config.TRUST_PROXY,
    // JSON bodies only (image originals go straight to storage). The largest legitimate one, a story
    // with the maximum area, content and sources, is well under this.
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", ...CLARITY_ORIGINS],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...MAP_ORIGINS, ...CLARITY_IMAGE_ORIGINS, ...imageOrigins],
        connectSrc: ["'self'", ...MAP_ORIGINS, ...CLARITY_ORIGINS, ...uploadOrigins],
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
  await app.register(rateLimit, {
    global: true,
    max: POLICY.requestsPerMinute,
    timeWindow: '1 minute',
    hook: 'preHandler',
    // Shared across instances when Redis is configured. If Redis is unreachable, requests are let
    // through rather than failing the whole site; per-user daily limits still live in PostgreSQL.
    redis: coordinator.rateLimitRedis ?? undefined,
    nameSpace: `${coordinator.keyPrefix}rl:`,
    skipOnError: true,
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    // Decide by the route that matched (the router decodes the path; `/%61pi/...` routes like `/api/...`).
    const path = req.routeOptions.url ?? req.url;
    const isApi = path.startsWith('/api/') || path.startsWith('/auth/');
    if (!isApi) return;
    // CSRF protection: state-changing requests must come from our own pages.
    if (!SAFE_METHODS.has(req.method) && req.headers.origin !== config.APP_ORIGIN) {
      throw forbidden('Cross-site request blocked.', 'bad-origin');
    }
    const user = await getSessionUser(sql, req.cookies[SESSION_COOKIE]);
    // Moderator access follows ADMIN_EMAILS: taking someone off the list takes effect on their next
    // request, not only at their next sign-in (which also stores the lower level).
    // It is stored too, so their profile and moderators' tools stop treating them as a Moderator.
    if (user && user.trustLevel >= TRUST.MODERATOR && !config.ADMIN_EMAILS.includes(user.email ?? '')) {
      user.trustLevel = TRUST.REVIEWER;
      await sql`UPDATE users SET trust_level = ${TRUST.REVIEWER} WHERE id = ${user.id} AND trust_level > ${TRUST.REVIEWER}`;
    }
    req.user = user;
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

  const deps: Deps = { config, sql, storage, coordinator };

  await app.register(googleAuthRoutes({ sql, config }));
  await app.register(sessionRoutes(deps));
  await app.register(cellRoutes(deps));
  await app.register(storyRoutes(deps));
  await app.register(discoveryRoutes(deps));
  await app.register(contributionRoutes(deps));
  await app.register(uploadRoutes(deps));
  await app.register(moderationRoutes(deps));
  await app.register(userRoutes(deps));
  await app.register(usageRoutes({ config, sql, coordinator }));
  await app.register(placeRoutes({ config, coordinator }));
  await app.register(supportRoutes(deps));
  await app.register(settingsRoutes(deps));

  // In production the API also serves the built web app; in development Vite does.
  const serveWeb = config.NODE_ENV === 'production' && existsSync(webRoot);
  let indexHtml: string | undefined;
  if (config.VERCEL === '1') {
    // Vercel's CDN owns /assets/*; only page HTML is needed in the Function. Keep it behind
    // Fastify so Helmet's environment-specific CSP still applies. Avoid loading @fastify/static
    // here: its CommonJS entry requires ESM-only content-disposition, which Vercel rejects.
    indexHtml = await readFile(join(webRoot, 'index.html'), 'utf8');
  } else if (storage.localDir || serveWeb) {
    const { default: fastifyStatic } = await import('@fastify/static');
    if (storage.localDir) {
      await app.register(fastifyStatic, {
        root: storage.localDir,
        prefix: '/media/',
        decorateReply: false,
        immutable: true,
        maxAge: '365d',
      });
    }
    if (serveWeb) {
      await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false });
    }
  }
  app.setNotFoundHandler((req, reply) => {
    if (serveWeb && isPageRequest(req.method, req.url)) {
      if (indexHtml !== undefined) {
        reply.type('text/html; charset=utf-8');
        if (req.method === 'HEAD') return reply.header('content-length', Buffer.byteLength(indexHtml)).send();
        return reply.send(indexHtml);
      }
      return reply.sendFile('index.html', webRoot);
    }
    return reply.code(404).send({ error: 'not-found', message: 'Not found.' });
  });

  return app;
}
