import { REPUTATION, TRUST, type Me, type ReputationBreakdown } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { conflict } from '../errors.js';
import { earnedTrustLevel } from '../policy.js';
import { getRules } from './settings.js';

export function toMe(user: SessionUser): Me {
  return {
    id: user.id,
    displayName: user.displayName,
    trustLevel: user.trustLevel,
    termsAccepted: !!user.termsAcceptedAt,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface Standing {
  reputation: number;
  breakdown: ReputationBreakdown;
  others: number;
  activeWeeks: number;
}

/**
 * Someone's reputation, computed from what happened to their contributions (see REPUTATION). Only
 * published stories count; edits count once per story improved, so repeatedly editing one story
 * can't farm it; corrections, sources and steady weeks of accepted work count; rejected, removed and
 * corrected work costs points.
 */
export async function reputationOf(sql: Db, userId: string): Promise<Standing> {
  const R = REPUTATION;
  const [row] = await sql<(ReputationBreakdown & { others: number })[]>`
    WITH pub AS (
      SELECT r.sources FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
      WHERE s.created_by = ${userId} AND s.status = 'active' AND s.published_at IS NOT NULL
    ), improved AS (
      SELECT DISTINCT r.story_id FROM story_revisions r JOIN stories s ON s.id = r.story_id
      WHERE r.author_id = ${userId} AND r.origin = 'edit' AND r.status = 'accepted' AND r.hidden_at IS NULL
        AND s.status = 'active' AND s.created_by <> ${userId}
    ), corrected AS (
      SELECT DISTINCT c.story_id FROM corrections c JOIN stories s ON s.id = c.story_id
      WHERE c.author_id = ${userId} AND c.status = 'accepted' AND c.hidden_at IS NULL AND s.created_by <> ${userId}
    ), devs AS (
      SELECT d.story_id, count(*) AS n FROM story_developments d JOIN stories s ON s.id = d.story_id
      WHERE d.author_id = ${userId} AND d.status = 'accepted' AND d.hidden_at IS NULL AND s.status = 'active'
      GROUP BY d.story_id
    ), weeks AS (
      SELECT DISTINCT date_trunc('week', at) FROM (
        SELECT COALESCE(reviewed_at, created_at) AS at FROM story_revisions
          WHERE author_id = ${userId} AND origin IN ('create', 'edit') AND status = 'accepted' AND hidden_at IS NULL
        UNION ALL SELECT COALESCE(reviewed_at, created_at) FROM story_developments
          WHERE author_id = ${userId} AND status = 'accepted' AND hidden_at IS NULL
        UNION ALL SELECT resolved_at FROM corrections
          WHERE author_id = ${userId} AND status = 'accepted' AND hidden_at IS NULL
      ) t
    )
    SELECT
      (SELECT count(*) FROM pub)::int AS published_stories,
      (SELECT COALESCE(sum(LEAST(${R.sourcesPerStoryMax},
        (SELECT count(*) FROM jsonb_array_elements(p.sources) e WHERE COALESCE(e->>'url', '') <> ''))), 0) FROM pub p)::int AS linked_sources,
      (SELECT count(*) FROM improved)::int AS improved_stories,
      (SELECT COALESCE(sum(LEAST(${R.developmentsPerStoryMax}, n)), 0) FROM devs)::int AS developments,
      (SELECT count(*) FROM corrections WHERE author_id = ${userId} AND status = 'accepted' AND hidden_at IS NULL)::int AS corrections_accepted,
      (SELECT count(*) FROM weeks)::int AS active_weeks,
      (SELECT count(*) FROM corrections WHERE author_id = ${userId} AND status = 'rejected' AND hidden_at IS NULL)::int AS corrections_rejected,
      (SELECT count(*) FROM story_revisions
        WHERE author_id = ${userId} AND origin IN ('create', 'edit') AND status = 'rejected' AND hidden_at IS NULL)::int AS edits_rejected,
      (SELECT count(*) FROM corrections c JOIN stories s ON s.id = c.story_id
        WHERE s.created_by = ${userId} AND c.author_id <> ${userId} AND c.status = 'accepted' AND c.hidden_at IS NULL)::int AS corrected_stories,
      ((SELECT count(*) FROM story_revisions WHERE author_id = ${userId} AND origin IN ('create', 'edit') AND hidden_at IS NOT NULL)
        + (SELECT count(*) FROM story_developments WHERE author_id = ${userId} AND hidden_at IS NOT NULL)
        + (SELECT count(*) FROM corrections WHERE author_id = ${userId} AND hidden_at IS NOT NULL)
        + (SELECT count(*) FROM stories WHERE created_by = ${userId} AND status = 'hidden' AND published_at IS NOT NULL))::int AS removed,
      (SELECT count(*) FROM (SELECT story_id FROM improved UNION SELECT story_id FROM corrected) o)::int AS others`;
  const { others, ...breakdown } = row!;
  const points =
    breakdown.publishedStories * R.publishedStory +
    breakdown.linkedSources * R.linkedSource +
    breakdown.improvedStories * R.improvedStory +
    breakdown.developments * R.development +
    breakdown.correctionsAccepted * R.correctionAccepted +
    Math.min(breakdown.activeWeeks, R.activeWeeksMax) * R.activeWeek +
    breakdown.correctionsRejected * R.correctionRejected +
    breakdown.editsRejected * R.editRejected +
    breakdown.correctedStories * R.correctedStory +
    breakdown.removed * R.removed;
  return { reputation: Math.max(0, points), breakdown, others, activeWeeks: breakdown.activeWeeks };
}

/** Recomputes the automatically earned trust level after activity. Leaves levels a moderator set alone. */
export async function refreshTrust(sql: Sql, userId: string): Promise<void> {
  const [row] = await sql<{ trustLevel: number; trustLocked: boolean; createdAt: Date }[]>`
    SELECT trust_level, trust_locked, created_at FROM users WHERE id = ${userId}`;
  if (!row || row.trustLocked || row.trustLevel >= TRUST.MODERATOR) return;
  const ageDays = (Date.now() - row.createdAt.getTime()) / 86_400_000;
  const level = earnedTrustLevel(row.trustLevel, ageDays, await reputationOf(sql, userId), (await getRules(sql)).promotion);
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
  await sql.begin(async (tx) => {
    // Nothing is left to decide about an account that no longer exists.
    await tx`
      UPDATE ban_requests SET resolved_by = ${userId}, resolved_at = now(), resolution = 'deleted'
      WHERE user_id = ${userId} AND resolved_at IS NULL`;
    await tx`
      UPDATE reports SET resolved_by = ${userId}, resolved_at = now(), resolution = 'dismissed'
      WHERE target_type = 'user' AND target_id = ${userId} AND resolved_at IS NULL`;
    await anonymizeUser(tx, userId);
  });
}

/** Removes what identifies someone and signs them out everywhere. Signing in again starts a new account. */
export async function anonymizeUser(tx: Db, userId: string): Promise<void> {
  await tx`
    UPDATE users SET deleted_at = now(), email = NULL, display_name = 'Deleted user',
      google_sub = 'deleted:' || id::text
    WHERE id = ${userId}`;
  await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
}
