import { createHash, randomBytes } from 'node:crypto';
import type { TrustLevel } from '@hexstory/shared';
import type { Sql } from '../db.js';
import { POLICY } from '../policy.js';

export const SESSION_COOKIE = 'hx_session';

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  trustLevel: TrustLevel;
  termsAcceptedAt: Date | null;
  bannedAt: Date | null;
  createdAt: Date;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

export async function createSession(sql: Sql, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + POLICY.sessionDays * DAY_MS);
  await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${hashToken(token)}, ${userId}, ${expiresAt})`;
  return { token, expiresAt };
}

/** Resolves a cookie token to its user. Extends the session when it is past half its lifetime. */
export async function getSessionUser(sql: Sql, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const id = hashToken(token);
  const [row] = await sql<(SessionUser & { expiresAt: Date })[]>`
    SELECT u.id, u.email, u.display_name AS "displayName", u.trust_level AS "trustLevel",
           u.terms_accepted_at AS "termsAcceptedAt", u.banned_at AS "bannedAt", u.created_at AS "createdAt",
           s.expires_at AS "expiresAt"
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id} AND s.expires_at > now() AND u.deleted_at IS NULL`;
  if (!row) return null;

  if (row.expiresAt.getTime() - Date.now() < (POLICY.sessionDays * DAY_MS) / 2) {
    await sql`UPDATE sessions SET expires_at = ${new Date(Date.now() + POLICY.sessionDays * DAY_MS)} WHERE id = ${id}`;
  }
  const { expiresAt: _, ...user } = row;
  return user;
}

export async function deleteSession(sql: Sql, token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${hashToken(token)}`;
}

export function sessionCookieOptions(secure: boolean, maxAgeSeconds: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure, maxAge: maxAgeSeconds };
}
