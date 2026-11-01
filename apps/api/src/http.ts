import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { SessionUser } from './auth/sessions.js';
import { badRequest, forbidden, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw Object.assign(badRequest(`${where}${first?.message ?? 'Invalid input'}`, 'invalid-input'), {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** A user allowed to contribute: signed in, accepted the terms, not banned. */
export function requireWriter(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.bannedAt) throw forbidden('Your account has been suspended.', 'banned');
  if (!user.termsAcceptedAt) throw forbidden('Please accept the terms before contributing.', 'terms-required');
  return user;
}

export function requireTrust(req: FastifyRequest, level: number): SessionUser {
  const user = requireWriter(req);
  if (user.trustLevel < level) throw forbidden();
  return user;
}
