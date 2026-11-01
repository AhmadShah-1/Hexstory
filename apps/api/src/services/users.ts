import { TRUST, type Me } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Sql } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { earnedTrustLevel } from '../policy.js';
import { logModAction } from './modlog.js';

export function toMe(user: SessionUser): Me {
  return {
    id: user.id,
    displayName: user.displayName,
    trustLevel: user.trustLevel,
    termsAccepted: !!user.termsAcceptedAt,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Recomputes the automatically earned trust level after activity. */
export async function refreshTrust(sql: Sql, userId: string): Promise<void> {
  // Count distinct stories, not revisions, so repeatedly editing one's own story can't farm trust.
  const [row] = await sql<{ trustLevel: number; createdAt: Date; stories: number; othersStories: number }[]>`
    SELECT u.trust_level, u.created_at,
           (SELECT count(DISTINCT r.story_id)::int FROM story_revisions r
             WHERE r.author_id = u.id AND r.status = 'accepted') AS stories,
           (SELECT count(DISTINCT r.story_id)::int FROM story_revisions r JOIN stories s ON s.id = r.story_id
             WHERE r.author_id = u.id AND r.status = 'accepted' AND s.created_by <> u.id) AS others_stories
    FROM users u WHERE u.id = ${userId}`;
  if (!row || row.trustLevel >= TRUST.MODERATOR) return;
  const ageDays = (Date.now() - row.createdAt.getTime()) / 86_400_000;
  const level = earnedTrustLevel(row.trustLevel, ageDays, { stories: row.stories, othersStories: row.othersStories });
  if (level !== row.trustLevel) await sql`UPDATE users SET trust_level = ${level} WHERE id = ${userId}`;
}

export async function updateProfile(
  sql: Sql,
  userId: string,
  input: { displayName?: string; acceptTerms?: true },
): Promise<void> {
  if (input.displayName) {
    try {
      await sql`UPDATE users SET display_name = ${input.displayName} WHERE id = ${userId}`;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('That name is taken. Try another.', 'name-taken');
      throw err;
    }
  }
  if (input.acceptTerms) {
    await sql`UPDATE users SET terms_accepted_at = now() WHERE id = ${userId} AND terms_accepted_at IS NULL`;
  }
}

/**
 * Account deletion keeps contributions (they are CC BY-SA licensed and part of shared history)
 * but removes everything that identifies the person.
 */
export async function deleteAccount(sql: Sql, userId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE users SET deleted_at = now(), email = NULL, display_name = 'Deleted user',
        google_sub = 'deleted:' || id::text
      WHERE id = ${userId}`;
    await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
  });
}

export async function setBanned(sql: Sql, actor: SessionUser, userId: string, banned: boolean, reason: string | null) {
  if (actor.trustLevel < TRUST.MODERATOR) throw forbidden();
  if (actor.id === userId) throw forbidden('You cannot ban yourself.');
  const [target] = await sql<{ trustLevel: number }[]>`SELECT trust_level AS "trustLevel" FROM users WHERE id = ${userId}`;
  if (!target) throw notFound('User');
  if (target.trustLevel >= TRUST.MODERATOR) throw forbidden('Moderators cannot ban other moderators.');
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET banned_at = ${banned ? new Date() : null} WHERE id = ${userId}`;
    if (banned) await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
    await logModAction(tx, actor.id, banned ? 'ban' : 'unban', 'user', userId, reason);
  });
}
