import { TRUST, type Me } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { conflict } from '../errors.js';
import { earnedTrustLevel } from '../policy.js';

export function toMe(user: SessionUser): Me {
  return {
    id: user.id,
    displayName: user.displayName,
    trustLevel: user.trustLevel,
    termsAccepted: !!user.termsAcceptedAt,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * What counts toward promotion: distinct *published* stories with an accepted, not-removed version by
 * this user, and how many of those someone else started. Counting stories rather than versions means
 * repeatedly editing one story can't farm trust.
 */
export async function contributionCounts(sql: Db, userId: string): Promise<{ stories: number; othersStories: number }> {
  const [row] = await sql<{ stories: number; othersStories: number }[]>`
    SELECT count(DISTINCT r.story_id)::int AS stories,
           count(DISTINCT r.story_id) FILTER (WHERE s.created_by <> ${userId})::int AS others_stories
    FROM story_revisions r JOIN stories s ON s.id = r.story_id
    WHERE r.author_id = ${userId} AND r.status = 'accepted' AND r.hidden_at IS NULL AND s.status = 'active'`;
  return row ?? { stories: 0, othersStories: 0 };
}

/** Recomputes the automatically earned trust level after activity. Leaves levels a moderator set alone. */
export async function refreshTrust(sql: Sql, userId: string): Promise<void> {
  const [row] = await sql<{ trustLevel: number; trustLocked: boolean; createdAt: Date }[]>`
    SELECT trust_level, trust_locked, created_at FROM users WHERE id = ${userId}`;
  if (!row || row.trustLocked || row.trustLevel >= TRUST.MODERATOR) return;
  const ageDays = (Date.now() - row.createdAt.getTime()) / 86_400_000;
  const level = earnedTrustLevel(row.trustLevel, ageDays, await contributionCounts(sql, userId));
  if (level !== row.trustLevel) {
    await sql`UPDATE users SET trust_level = ${level} WHERE id = ${userId} AND NOT trust_locked`;
  }
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
  await sql.begin((tx) => anonymizeUser(tx, userId));
}

/** Removes what identifies someone and signs them out everywhere. Signing in again starts a new account. */
export async function anonymizeUser(tx: Db, userId: string): Promise<void> {
  await tx`
    UPDATE users SET deleted_at = now(), email = NULL, display_name = 'Deleted user',
      google_sub = 'deleted:' || id::text
    WHERE id = ${userId}`;
  await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
}
