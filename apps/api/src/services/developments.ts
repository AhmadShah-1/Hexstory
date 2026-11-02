import type { CreateDevelopmentInput, DateParts, Development, Location, Page, RevisionStatus, Source } from '@hexstory/shared';
import type { z } from 'zod';
import type { createDevelopmentSchema } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { canReview, liveEditThreshold } from '../policy.js';
import { logModAction } from './modlog.js';
import { assertVisible, assertWithinDailyLimit, closeReportsAbout, fetchStory, invalidateMapCache, type StoryDeps } from './stories.js';
import { refreshTrust } from './users.js';

export type DevelopmentData = z.output<typeof createDevelopmentSchema>;
export type { CreateDevelopmentInput };

interface DevelopmentRow {
  id: string;
  storyId: string;
  year: number;
  month: number | null;
  day: number | null;
  title: string;
  body: string | null;
  lat: number | null;
  lng: number | null;
  placeName: string | null;
  sources: Source[];
  status: RevisionStatus;
  hiddenAt: Date | null;
  authorId: string;
  authorName: string;
  createdAt: Date;
}

export function toDevelopment(r: DevelopmentRow): Development {
  const location: Location | null = r.lat === null || r.lng === null ? null : { lat: r.lat, lng: r.lng, placeName: r.placeName };
  const date: DateParts = { year: r.year, month: r.month, day: r.day };
  return {
    id: r.id,
    storyId: r.storyId,
    date,
    title: r.title,
    body: r.body,
    location,
    sources: r.sources,
    status: r.status,
    removed: !!r.hiddenAt,
    author: { id: r.authorId, displayName: r.authorName },
    createdAt: r.createdAt.toISOString(),
  };
}

export const developmentColumns = (sql: Db) => sql`
  d.id, d.story_id, d.year, d.month, d.day, d.title, d.body, d.lat, d.lng, d.place_name, d.sources, d.status, d.hidden_at,
  d.created_at, u.id AS author_id, u.display_name AS author_name`;

/**
 * Who sees a development: accepted ones are public; held or turned-down ones only their author and
 * reviewers; removed ones reviewers only (the same rules as story versions).
 */
const visibleTo = (sql: Db, viewer: SessionUser | null) =>
  viewer && canReview(viewer.trustLevel)
    ? sql`true`
    : sql`(d.hidden_at IS NULL AND (d.status = 'accepted' OR d.author_id = ${viewer?.id ?? null}))`;

/** An event's timeline, newest development first (by the date it happened, then when it was posted). */
export async function listDevelopments(
  { sql }: StoryDeps,
  storyId: string,
  viewer: SessionUser | null,
  offset = 0,
  limit = 50,
): Promise<Page<Development>> {
  const rows = await sql<DevelopmentRow[]>`
    SELECT ${developmentColumns(sql)}
    FROM story_developments d JOIN users u ON u.id = d.author_id
    WHERE d.story_id = ${storyId} AND ${visibleTo(sql, viewer)}
    ORDER BY d.sort_key DESC, d.created_at DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  return { items: rows.slice(0, limit).map(toDevelopment), nextOffset: rows.length > limit ? offset + limit : null };
}

export async function storyDevelopments(deps: StoryDeps, storyId: string, viewer: SessionUser | null, offset: number) {
  const story = await fetchStory(deps.sql, storyId);
  assertVisible(story, viewer);
  return listDevelopments(deps, storyId, viewer, offset);
}

/**
 * Adds a development to an event's timeline. It goes live under the same rule as an edit (Members, or
 * the creator of a story still waiting for approval; protected stories need the protection level);
 * otherwise it waits for a reviewer. Developments count toward the daily edit allowance.
 */
export async function addDevelopment(
  { sql }: StoryDeps,
  user: SessionUser,
  storyId: string,
  input: DevelopmentData,
): Promise<{ id: string; status: 'live' | 'pending' }> {
  const result = await sql.begin(async (tx) => {
    await assertWithinDailyLimit(tx, user, 'edits');
    const story = await fetchStory(tx, storyId, true);
    assertVisible(story, user);
    if (story.status === 'hidden') throw conflict('This story is hidden.');
    if (!story.currentRevisionId) throw conflict('This story is still waiting for its first review.');
    const creatorOfUnreviewed = story.status === 'unreviewed' && story.createdBy === user.id;
    const live = user.trustLevel >= liveEditThreshold(story.protectionLevel) || creatorOfUnreviewed;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO story_developments (story_id, author_id, year, month, day, title, body, lat, lng, place_name, sources, status,
        reviewed_by, reviewed_at)
      VALUES (${storyId}, ${user.id}, ${input.date.year}, ${input.date.month ?? null}, ${input.date.day ?? null}, ${input.title},
        ${input.body ?? null}, ${input.location?.lat ?? null}, ${input.location?.lng ?? null}, ${input.location?.placeName ?? null},
        ${tx.json(input.sources.map((s) => ({ title: s.title, url: s.url ?? null })))}, ${live ? 'accepted' : 'pending'},
        null, null)
      RETURNING id`;
    if (live) await tx`UPDATE stories SET last_update_at = now() WHERE id = ${storyId}`;
    return { id: row!.id, status: live ? ('live' as const) : ('pending' as const) };
  });
  if (result.status === 'live') {
    invalidateMapCache();
    await refreshTrust(sql, user.id);
  }
  return result;
}

/** Reviewers accept or turn down a held development. Nobody reviews their own. */
export async function reviewDevelopment(sql: Sql, user: SessionUser, id: string, decision: 'accept' | 'reject', reason: string | null) {
  if (!canReview(user.trustLevel)) throw forbidden();
  const authorId = await sql.begin(async (tx) => {
    const [dev] = await tx<{ storyId: string; authorId: string; status: RevisionStatus; hiddenAt: Date | null }[]>`
      SELECT story_id, author_id, status, hidden_at FROM story_developments WHERE id = ${id} FOR UPDATE`;
    if (!dev || dev.hiddenAt) throw notFound('Development');
    if (dev.status !== 'pending') throw conflict('This development was already reviewed.', 'already-decided');
    if (dev.authorId === user.id) throw forbidden('You cannot review your own contribution.');
    const story = await fetchStory(tx, dev.storyId, true);
    if (!story) throw notFound('Story');
    if (decision === 'accept') {
      if (story.status === 'hidden') throw conflict('This story is hidden. Bring it back before accepting additions to it.');
      if (user.trustLevel < liveEditThreshold(story.protectionLevel)) throw forbidden('This story is protected: only a moderator can accept additions to it.');
      await tx`UPDATE stories SET last_update_at = now() WHERE id = ${dev.storyId}`;
    }
    await tx`
      UPDATE story_developments SET status = ${decision === 'accept' ? 'accepted' : 'rejected'}, reviewed_by = ${user.id}, reviewed_at = now()
      WHERE id = ${id}`;
    await logModAction(tx, user.id, `development:${decision}`, 'development', id, reason);
    return dev.authorId;
  });
  invalidateMapCache();
  await refreshTrust(sql, authorId);
}

/** Reviewers remove a development from the timeline (abuse, personal details). It stays for reviewers only. */
export async function removeDevelopment(sql: Sql, user: SessionUser, id: string, reason: string | null) {
  if (!canReview(user.trustLevel)) throw forbidden();
  const authorId = await sql.begin(async (tx) => {
    const [dev] = await tx<{ authorId: string; hiddenAt: Date | null }[]>`
      SELECT author_id, hidden_at FROM story_developments WHERE id = ${id} FOR UPDATE`;
    if (!dev) throw notFound('Development');
    if (dev.hiddenAt) throw conflict('This development was already removed.', 'already-decided');
    await tx`
      UPDATE story_developments SET hidden_at = now(),
        status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
        reviewed_by = CASE WHEN status = 'pending' THEN ${user.id}::uuid ELSE reviewed_by END,
        reviewed_at = CASE WHEN status = 'pending' THEN now() ELSE reviewed_at END
      WHERE id = ${id}`;
    await closeReportsAbout(tx, user.id, 'development', [id]);
    await logModAction(tx, user.id, 'remove-development', 'development', id, reason);
    return dev.authorId;
  });
  invalidateMapCache();
  await refreshTrust(sql, authorId);
}

/** Held developments for the Watchtower, oldest first (not on hidden stories or from banned people). */
export async function pendingDevelopments(sql: Sql): Promise<(Development & { storyTitle: string })[]> {
  const rows = await sql<(DevelopmentRow & { storyTitle: string })[]>`
    SELECT ${developmentColumns(sql)}, r.title AS story_title
    FROM story_developments d
    JOIN users u ON u.id = d.author_id
    JOIN stories s ON s.id = d.story_id
    JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE d.status = 'pending' AND d.hidden_at IS NULL AND u.banned_at IS NULL AND s.status <> 'hidden'
    ORDER BY d.created_at
    LIMIT 50`;
  return rows.map((r) => ({ ...toDevelopment(r), storyTitle: r.storyTitle }));
}
