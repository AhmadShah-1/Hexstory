import { randomInt } from 'node:crypto';
import { Google, decodeIdToken, generateCodeVerifier, generateState } from 'arctic';
import type { FastifyPluginAsync } from 'fastify';
import { LIMITS, TRUST } from '@hexstory/shared';
import { isGoogleConfigured, type Config } from '../config.js';
import type { Sql } from '../db.js';
import { refreshTrust } from '../services/users.js';
import { POLICY } from '../policy.js';
import { SESSION_COOKIE, createSession, deleteSession, sessionCookieOptions } from './sessions.js';

const FLOW_COOKIE_MAX_AGE = 10 * 60;

interface GoogleClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  name?: string;
}

/**
 * Only same-site relative paths are allowed, so the redirect can't be abused as an open redirect.
 * Control characters, spaces and backslashes are rejected outright: browsers strip or reinterpret
 * them, which turns "/\t/evil.com" into "//evil.com".
 */
export function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && value.length <= 512 && /^\/(?![/\\])[^\x00-\x20\x7f\\]*$/.test(value) ? value : '/';
}

export const googleAuthRoutes =
  (deps: { sql: Sql; config: Config }): FastifyPluginAsync =>
  async (app) => {
    const { sql, config } = deps;
    const secure = config.NODE_ENV === 'production';
    const google = isGoogleConfigured(config)
      ? new Google(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!, `${config.APP_ORIGIN}/auth/google/callback`)
      : null;
    const flowCookie = { path: '/auth', httpOnly: true, sameSite: 'lax' as const, secure, maxAge: FLOW_COOKIE_MAX_AGE };

    app.get('/auth/google', async (req, reply) => {
      if (!google) return reply.redirect('/?signin=unavailable');
      const state = generateState();
      const verifier = generateCodeVerifier();
      const url = google.createAuthorizationURL(state, verifier, ['openid', 'email', 'profile']);
      url.searchParams.set('prompt', 'select_account');
      reply
        .setCookie('hx_oauth_state', state, flowCookie)
        .setCookie('hx_oauth_verifier', verifier, flowCookie)
        .setCookie('hx_oauth_return', safeReturnTo((req.query as { returnTo?: string }).returnTo), flowCookie);
      return reply.redirect(url.toString());
    });

    app.get('/auth/google/callback', async (req, reply) => {
      const { code, state } = req.query as { code?: string; state?: string };
      const { hx_oauth_state, hx_oauth_verifier, hx_oauth_return } = req.cookies;
      const returnTo = safeReturnTo(hx_oauth_return);
      for (const name of ['hx_oauth_state', 'hx_oauth_verifier', 'hx_oauth_return']) {
        reply.clearCookie(name, { path: '/auth' });
      }
      if (!google || !code || !state || !hx_oauth_verifier || state !== hx_oauth_state) {
        return reply.redirect('/?signin=failed');
      }

      let claims: GoogleClaims;
      try {
        const tokens = await google.validateAuthorizationCode(code, hx_oauth_verifier);
        claims = decodeIdToken(tokens.idToken()) as GoogleClaims;
      } catch (err) {
        req.log.warn({ err }, 'google sign-in failed');
        return reply.redirect('/?signin=failed');
      }
      if (!claims.sub || !claims.email || claims.email_verified === false) {
        return reply.redirect('/?signin=failed');
      }

      const userId = await upsertGoogleUser(sql, config, claims);
      const [user] = await sql<{ bannedAt: Date | null }[]>`SELECT banned_at AS "bannedAt" FROM users WHERE id = ${userId}`;
      if (user?.bannedAt) return reply.redirect('/?signin=banned');

      const session = await createSession(sql, userId);
      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(secure, POLICY.sessionDays * 24 * 3600));
      return reply.redirect(returnTo);
    });

    app.post('/auth/logout', async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await deleteSession(sql, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });
  };

async function upsertGoogleUser(sql: Sql, config: Config, claims: GoogleClaims): Promise<string> {
  const email = claims.email!.toLowerCase();
  const isAdmin = config.ADMIN_EMAILS.includes(email);
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM users WHERE google_sub = ${claims.sub}`;

  if (existing) {
    await sql`
      UPDATE users SET email = ${email},
        trust_level = CASE WHEN ${isAdmin} THEN ${TRUST.MODERATOR} ELSE trust_level END
      WHERE id = ${existing.id}`;
    await refreshTrust(sql, existing.id);
    return existing.id;
  }

  // Display names are public, so we suggest only the first name; users can change it on the welcome screen.
  const cleaned = sanitizeName(claims.given_name ?? claims.name ?? '');
  const base = cleaned.length >= LIMITS.displayNameMin ? cleaned : 'Traveler';
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = attempt === 0 ? base : `${base.slice(0, LIMITS.displayNameMax - 5)}${randomInt(1000, 9999)}`;
    const [created] = await sql<{ id: string }[]>`
      INSERT INTO users (google_sub, email, display_name, trust_level)
      VALUES (${claims.sub}, ${email}, ${candidate}, ${isAdmin ? TRUST.MODERATOR : TRUST.NEW})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (created) return created.id;
  }
  throw new Error('Could not allocate a display name');
}

function sanitizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
    .slice(0, LIMITS.displayNameMax);
}
