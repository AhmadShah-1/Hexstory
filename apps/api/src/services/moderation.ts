import {
  TRUST,
  type AuditEntry,
  type BanRequest,
  type BanRequestGroup,
  type CleanupSummary,
  type ModUserRow,
  type Page,
  type TrustLevel,
  type UserProfile,
} from '@hexstory/shared';
import type { PendingQuery, Row } from 'postgres';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { POLICY, canReview, nextEarnedLevel } from '../policy.js';
import { logModAction } from './modlog.js';
import { closeReportsAbout, copyToNewRevision, fetchStory, invalidateCellCounts } from './stories.js';
import { anonymizeUser, contributionCounts, refreshTrust } from './users.js';

/** Chat messages to drop live from open Squares (the database already hides them). */
export type LiveHide = { id: string; cell: string }[];

const CLEANUP_REASON = 'Ban clean-up';

function assertModerator(actor: SessionUser) {
  if (actor.trustLevel < TRUST.MODERATOR) throw forbidden();
}

interface TargetRow {
  id: string;
  trustLevel: TrustLevel;
  bannedAt: Date | null;
  deletedAt: Date | null;
}

/** Locks the user an action is about and checks it may be applied to them at all. */
async function lockTarget(tx: Db, actor: SessionUser, userId: string): Promise<TargetRow> {
  if (actor.id === userId) throw forbidden('You cannot do that to your own account.');
  const [target] = await tx<TargetRow[]>`
    SELECT id, trust_level, banned_at, deleted_at FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!target || target.deletedAt) throw notFound('User');
  if (target.trustLevel >= TRUST.MODERATOR) {
    throw forbidden('Moderators can’t be banned, deleted or changed here: their access comes from ADMIN_EMAILS.');
  }
  return target;
}

/** Open reports about a user or anything they wrote. `u` must be in scope. */
const openReportsAboutUser = (sql: Db) => sql`(
  SELECT count(*)::int FROM reports rp
  WHERE rp.resolved_at IS NULL AND (
    (rp.target_type = 'user' AND rp.target_id = u.id::text)
    OR (rp.target_type = 'story' AND rp.target_id IN (SELECT s.id::text FROM stories s WHERE s.created_by = u.id))
    OR (rp.target_type = 'revision' AND rp.target_id IN (SELECT r.id::text FROM story_revisions r WHERE r.author_id = u.id))
    OR (rp.target_type = 'comment' AND rp.target_id IN (SELECT c.id::text FROM comments c WHERE c.user_id = u.id))))`;

// ---------------------------------------------------------------------------------------------
// User pages

export async function getUserProfile(sql: Sql, viewer: SessionUser | null, userId: string): Promise<UserProfile> {
  const [u] = await sql<
    { id: string; displayName: string; trustLevel: TrustLevel; trustLocked: boolean; createdAt: Date; bannedAt: Date | null; deletedAt: Date | null }[]
  >`SELECT id, display_name, trust_level, trust_locked, created_at, banned_at, deleted_at FROM users WHERE id = ${userId}`;
  if (!u) throw notFound('User');
  const self = viewer?.id === u.id;
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  const profile: UserProfile = {
    id: u.id,
    displayName: u.displayName,
    trustLevel: u.trustLevel,
    createdAt: u.createdAt.toISOString(),
    deleted: !!u.deletedAt,
    details: null,
    moderation: null,
  };
  if (!self && !reviewer) return profile;

  const [stats] = await sql<
    { storiesStarted: number; storiesLive: number; edits: number; editsLive: number; editsWaiting: number; editsRejected: number;
      messages: number; storiesToday: number; editsToday: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM stories WHERE created_by = ${userId}) AS stories_started,
      (SELECT count(*)::int FROM stories WHERE created_by = ${userId} AND status = 'active' AND current_revision_id IS NOT NULL) AS stories_live,
      (SELECT count(*)::int FROM story_revisions WHERE author_id = ${userId}) AS edits,
      (SELECT count(*)::int FROM story_revisions WHERE author_id = ${userId} AND status = 'accepted' AND hidden_at IS NULL) AS edits_live,
      (SELECT count(*)::int FROM story_revisions WHERE author_id = ${userId} AND status = 'pending') AS edits_waiting,
      (SELECT count(*)::int FROM story_revisions WHERE author_id = ${userId} AND status = 'rejected') AS edits_rejected,
      (SELECT count(*)::int FROM comments WHERE user_id = ${userId} AND hidden_at IS NULL) AS messages,
      (SELECT count(*)::int FROM stories WHERE created_by = ${userId} AND created_at > now() - interval '1 day') AS stories_today,
      (SELECT count(*)::int FROM story_revisions WHERE author_id = ${userId} AND created_at > now() - interval '1 day') AS edits_today`;
  const { storiesToday, editsToday, ...counts } = stats!;
  const progress = await contributionCounts(sql, userId);
  const next = u.trustLocked ? null : nextEarnedLevel(u.trustLevel);
  const rule = next === TRUST.MEMBER ? POLICY.promotion.member : POLICY.promotion.reviewer;
  profile.details = {
    stats: counts,
    progress: {
      ageDays: Math.floor((Date.now() - u.createdAt.getTime()) / 86_400_000),
      ...progress,
      next: next === null ? null : { level: next, ...rule },
    },
    trustLocked: u.trustLocked,
    today: {
      stories: storiesToday,
      storiesLimit: POLICY.storiesPerDay[u.trustLevel],
      edits: editsToday,
      editsLimit: POLICY.editsPerDay[u.trustLevel],
    },
  };

  if (reviewer) {
    const [extra] = await sql<{ openReports: number; banReason: string | null }[]>`
      SELECT ${openReportsAboutUser(sql)} AS open_reports,
             (SELECT reason FROM mod_actions WHERE target_type = 'user' AND target_id = ${userId} AND action = 'ban'
              ORDER BY created_at DESC LIMIT 1) AS ban_reason
      FROM users u WHERE u.id = ${userId}`;
    profile.moderation = {
      banned: u.bannedAt ? { at: u.bannedAt.toISOString(), reason: extra?.banReason ?? null } : null,
      openReports: extra?.openReports ?? 0,
      banRequests: (await openBanRequests(sql, [userId])).map(({ userId: _, ...r }) => r),
    };
  }
  return profile;
}

// ---------------------------------------------------------------------------------------------
// Moderators' user list

async function userRows(sql: Db, where: PendingQuery<Row[]>, offset: number, limit: number): Promise<ModUserRow[]> {
  const rows = await sql<(Omit<ModUserRow, 'createdAt' | 'bannedAt'> & { createdAt: Date; bannedAt: Date | null })[]>`
    SELECT u.id, u.display_name, u.trust_level, u.trust_locked, u.created_at, u.banned_at,
           (SELECT count(*)::int FROM stories s WHERE s.created_by = u.id) AS stories,
           (SELECT count(*)::int FROM story_revisions r WHERE r.author_id = u.id) AS edits,
           ${openReportsAboutUser(sql)} AS open_reports,
           (SELECT count(*)::int FROM ban_requests b WHERE b.user_id = u.id AND b.resolved_at IS NULL) AS open_ban_requests
    FROM users u
    WHERE u.deleted_at IS NULL AND ${where}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${limit} OFFSET ${offset}`;
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), bannedAt: r.bannedAt?.toISOString() ?? null }));
}

export type UserFilter = 'all' | 'banned' | 'requested' | 'reported';

export async function listUsers(
  sql: Sql,
  actor: SessionUser,
  query: { q?: string; level?: TrustLevel; filter: UserFilter; offset: number },
): Promise<Page<ModUserRow>> {
  assertModerator(actor);
  const limit = 50;
  const q = query.q?.trim();
  const where = sql`true
    ${q ? sql`AND u.display_name ILIKE ${`%${q.replace(/[\\%_]/g, '\\$&')}%`}` : sql``}
    ${query.level !== undefined ? sql`AND u.trust_level = ${query.level}` : sql``}
    ${query.filter === 'banned' ? sql`AND u.banned_at IS NOT NULL` : sql``}
    ${query.filter === 'requested' ? sql`AND EXISTS (SELECT 1 FROM ban_requests b WHERE b.user_id = u.id AND b.resolved_at IS NULL)` : sql``}
    ${query.filter === 'reported' ? sql`AND ${openReportsAboutUser(sql)} > 0` : sql``}`;
  const rows = await userRows(sql, where, query.offset, limit + 1);
  return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? query.offset + limit : null };
}

// ---------------------------------------------------------------------------------------------
// Ban requests: reviewers ask, moderators decide

async function openBanRequests(sql: Db, userIds: string[]): Promise<(BanRequest & { userId: string })[]> {
  const rows = await sql<{ id: string; userId: string; reason: string; createdAt: Date; byId: string; byName: string }[]>`
    SELECT b.id, b.user_id, b.reason, b.created_at, ru.id AS by_id, ru.display_name AS by_name
    FROM ban_requests b JOIN users ru ON ru.id = b.requested_by
    WHERE b.resolved_at IS NULL AND b.user_id IN ${sql(userIds)}
    ORDER BY b.created_at`;
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    requestedBy: { id: r.byId, displayName: r.byName },
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function requestBan(sql: Sql, actor: SessionUser, userId: string, reason: string): Promise<void> {
  if (!canReview(actor.trustLevel)) throw forbidden();
  await sql.begin(async (tx) => {
    const target = await lockTarget(tx, actor, userId);
    if (target.bannedAt) throw conflict('This account is already banned.');
    const [row] = await tx`
      INSERT INTO ban_requests (user_id, requested_by, reason) VALUES (${userId}, ${actor.id}, ${reason})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (!row) throw conflict('You already asked moderators to ban this account. They will decide soon.');
    await logModAction(tx, actor.id, 'ban-request', 'user', userId, reason);
  });
}

/** Users with open ban requests, oldest request first. */
export async function banRequestQueue(sql: Sql, actor: SessionUser): Promise<BanRequestGroup[]> {
  assertModerator(actor);
  const open = await sql<{ userId: string }[]>`
    SELECT user_id FROM ban_requests WHERE resolved_at IS NULL GROUP BY user_id ORDER BY min(created_at) LIMIT 100`;
  if (!open.length) return [];
  const ids = open.map((o) => o.userId);
  const users = await userRows(sql, sql`u.id IN ${sql(ids)}`, 0, ids.length);
  const requests = await openBanRequests(sql, ids);
  const byUser = new Map(users.map((u) => [u.id, u]));
  return ids.flatMap((id) => {
    const user = byUser.get(id);
    if (!user) return []; // deleted meanwhile
    return [{ user, requests: requests.filter((r) => r.userId === id).map(({ userId: _, ...r }) => r) }];
  });
}

async function resolveBanRequests(tx: Db, actorId: string, userId: string, resolution: 'banned' | 'declined' | 'deleted'): Promise<number> {
  const rows = await tx`
    UPDATE ban_requests SET resolved_by = ${actorId}, resolved_at = now(), resolution = ${resolution}
    WHERE user_id = ${userId} AND resolved_at IS NULL
    RETURNING id`;
  return rows.length;
}

export async function declineBanRequests(sql: Sql, actor: SessionUser, userId: string, reason: string | null): Promise<void> {
  assertModerator(actor);
  await sql.begin(async (tx) => {
    const declined = await resolveBanRequests(tx, actor.id, userId, 'declined');
    if (!declined) throw notFound('Open ban request');
    await logModAction(tx, actor.id, 'ban-request:declined', 'user', userId, reason, { requests: declined });
  });
}

// ---------------------------------------------------------------------------------------------
// Bans, clean-up, deletion, levels

/**
 * Takes down everything a user contributed, without destroying the record:
 * - stories they started are hidden (moderators can bring individual ones back);
 * - stories where their edit is the current version roll back to the latest version by someone else
 *   (hidden if there is none);
 * - their held edits are rejected, and all their versions are removed from the history, so nobody can
 *   view or restore them;
 * - their chat messages are hidden; open reports they filed are dismissed, reports about their
 *   content are closed as handled.
 * Changes others made on top of their edits stay; reviewers can restore further back by hand.
 */
async function removeContentOf(tx: Db, actor: SessionUser, userId: string): Promise<CleanupSummary> {
  const summary: CleanupSummary = { storiesHidden: 0, storiesRolledBack: 0, editsRejected: 0, versionsRemoved: 0, messagesHidden: 0, reportsClosed: 0 };

  const own = await tx<{ id: string }[]>`
    UPDATE stories SET status = 'hidden', updated_at = now()
    WHERE created_by = ${userId} AND status <> 'hidden'
    RETURNING id`;
  for (const story of own) await logModAction(tx, actor.id, 'hide', 'story', story.id, CLEANUP_REASON);
  summary.storiesHidden += own.length;

  summary.editsRejected = (await tx`
    UPDATE story_revisions SET status = 'rejected', reviewed_by = ${actor.id}, reviewed_at = now()
    WHERE author_id = ${userId} AND status = 'pending'
    RETURNING id`).length;

  const touched = await tx<{ id: string; fallback: string | null }[]>`
    SELECT s.id,
      (SELECT o.id FROM story_revisions o
        WHERE o.story_id = s.id AND o.status = 'accepted' AND o.hidden_at IS NULL AND o.author_id <> ${userId}
        ORDER BY o.created_at DESC LIMIT 1) AS fallback
    FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE r.author_id = ${userId} AND s.status <> 'hidden'
    ORDER BY s.id`;
  for (const { id, fallback } of touched) {
    const story = await fetchStory(tx, id, true);
    if (!story) continue;
    if (fallback) {
      await copyToNewRevision(tx, story, fallback, actor.id, 'Rolled back changes by a removed account');
      await logModAction(tx, actor.id, 'rollback', 'story', id, CLEANUP_REASON);
      summary.storiesRolledBack++;
    } else {
      await tx`UPDATE stories SET status = 'hidden', updated_at = now() WHERE id = ${id}`;
      await logModAction(tx, actor.id, 'hide', 'story', id, CLEANUP_REASON);
      summary.storiesHidden++;
    }
  }

  summary.versionsRemoved = (await tx`
    UPDATE story_revisions SET hidden_at = now() WHERE author_id = ${userId} AND hidden_at IS NULL RETURNING id`).length;
  summary.messagesHidden = (await tx`
    UPDATE comments SET hidden_at = now() WHERE user_id = ${userId} AND hidden_at IS NULL RETURNING id`).length;

  const filed = await tx`
    UPDATE reports SET resolved_by = ${actor.id}, resolved_at = now(), resolution = 'dismissed'
    WHERE reporter_id = ${userId} AND resolved_at IS NULL
    RETURNING id`;
  const about = await tx`
    UPDATE reports SET resolved_by = ${actor.id}, resolved_at = now(), resolution = 'actioned'
    WHERE resolved_at IS NULL AND (
      (target_type = 'story' AND target_id IN (SELECT id::text FROM stories WHERE created_by = ${userId}))
      OR (target_type = 'revision' AND target_id IN (SELECT id::text FROM story_revisions WHERE author_id = ${userId}))
      OR (target_type = 'comment' AND target_id IN (SELECT id::text FROM comments WHERE user_id = ${userId})))
    RETURNING id`;
  summary.reportsClosed = filed.length + about.length;
  return summary;
}

async function recentMessages(tx: Db, userId: string): Promise<LiveHide> {
  return tx<LiveHide>`
    SELECT id, cell FROM comments
    WHERE user_id = ${userId} AND created_at > now() - make_interval(hours => ${POLICY.banLiveHideHours})
    ORDER BY created_at DESC LIMIT 500`;
}

/**
 * Bans (or unbans) a user. A ban signs them out everywhere, blocks writing and chat, settles open ban
 * requests and reports about the account and, with `removeContent`, takes down what they contributed.
 * Banning an already-banned user with `removeContent` runs just the clean-up. Unbanning never brings
 * removed content back.
 */
export async function setBanned(
  sql: Sql,
  actor: SessionUser,
  userId: string,
  input: { banned: boolean; reason: string | null; removeContent: boolean },
): Promise<{ cleanup: CleanupSummary | null; liveHide: LiveHide }> {
  assertModerator(actor);
  const result = await sql.begin(async (tx) => {
    const target = await lockTarget(tx, actor, userId);
    if (!input.banned) {
      if (!target.bannedAt) throw conflict('This account is not banned.');
      await tx`UPDATE users SET banned_at = NULL WHERE id = ${userId}`;
      await logModAction(tx, actor.id, 'unban', 'user', userId, input.reason);
      return { cleanup: null, liveHide: [] };
    }
    if (target.bannedAt && !input.removeContent) throw conflict('This account is already banned.');

    await tx`UPDATE users SET banned_at = COALESCE(banned_at, now()) WHERE id = ${userId}`;
    await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
    const requests = await resolveBanRequests(tx, actor.id, userId, 'banned');
    const reports = await closeReportsAbout(tx, actor.id, 'user', [userId]);
    const cleanup = input.removeContent ? await removeContentOf(tx, actor, userId) : null;
    await logModAction(tx, actor.id, target.bannedAt ? 'ban:clean-up' : 'ban', 'user', userId, input.reason, {
      removeContent: input.removeContent,
      requestsResolved: requests,
      reportsClosed: reports + (cleanup?.reportsClosed ?? 0),
      ...(cleanup ?? {}),
    });
    return { cleanup, liveHide: await recentMessages(tx, userId) };
  });
  if (result.cleanup) invalidateCellCounts();
  return result;
}

/**
 * Deletes someone's account the way self-deletion does (anonymised, signed out; signing in again
 * starts a new account), optionally taking down their contributions first. To keep someone out,
 * ban them instead.
 */
export async function deleteUser(
  sql: Sql,
  actor: SessionUser,
  userId: string,
  input: { reason: string | null; removeContent: boolean },
): Promise<{ cleanup: CleanupSummary | null; liveHide: LiveHide }> {
  assertModerator(actor);
  const result = await sql.begin(async (tx) => {
    await lockTarget(tx, actor, userId);
    const cleanup = input.removeContent ? await removeContentOf(tx, actor, userId) : null;
    const liveHide = input.removeContent ? await recentMessages(tx, userId) : [];
    const requests = await resolveBanRequests(tx, actor.id, userId, 'deleted');
    const reports = await closeReportsAbout(tx, actor.id, 'user', [userId]);
    await anonymizeUser(tx, userId);
    await logModAction(tx, actor.id, 'delete-user', 'user', userId, input.reason, {
      removeContent: input.removeContent,
      requestsResolved: requests,
      reportsClosed: reports + (cleanup?.reportsClosed ?? 0),
      ...(cleanup ?? {}),
    });
    return { cleanup, liveHide };
  });
  if (result.cleanup) invalidateCellCounts();
  return result;
}

/**
 * Sets someone's level by hand (up to Reviewer; Moderators come from ADMIN_EMAILS), which pauses
 * automatic promotion for them, or (`auto`) hands their level back to the automatic rules, which may
 * promote them again straight away but never demote.
 */
export async function setTrustLevel(sql: Sql, actor: SessionUser, userId: string, level: 0 | 1 | 2 | 'auto', reason: string | null) {
  assertModerator(actor);
  await sql.begin(async (tx) => {
    const target = await lockTarget(tx, actor, userId);
    if (level === 'auto') {
      await tx`UPDATE users SET trust_locked = false WHERE id = ${userId}`;
      await logModAction(tx, actor.id, 'trust:auto', 'user', userId, reason, { from: target.trustLevel });
    } else {
      await tx`UPDATE users SET trust_level = ${level}, trust_locked = true WHERE id = ${userId}`;
      await logModAction(tx, actor.id, `trust:${level}`, 'user', userId, reason, { from: target.trustLevel });
    }
  });
  if (level === 'auto') await refreshTrust(sql, userId);
}

// ---------------------------------------------------------------------------------------------
// Audit log

export async function auditLog(
  sql: Sql,
  actor: SessionUser,
  query: { offset: number; actorId?: string; targetType?: string; targetId?: string; action?: string },
): Promise<Page<AuditEntry>> {
  assertModerator(actor);
  const limit = 50;
  const rows = await sql<
    { id: string; action: string; targetType: string; targetId: string; reason: string | null; details: Record<string, unknown> | null;
      createdAt: Date; actorId: string; actorName: string; label: string | null; storyId: string | null; userId: string | null; cell: string | null }[]
  >`
    SELECT m.id, m.action, m.target_type, m.target_id, m.reason, m.details, m.created_at,
           a.id AS actor_id, a.display_name AS actor_name,
           CASE m.target_type
             WHEN 'story' THEN (SELECT r.title FROM stories s JOIN story_revisions r ON r.id = COALESCE(s.current_revision_id,
               (SELECT f.id FROM story_revisions f WHERE f.story_id = s.id ORDER BY f.created_at LIMIT 1)) WHERE s.id::text = m.target_id)
             WHEN 'revision' THEN (SELECT r.title FROM story_revisions r WHERE r.id::text = m.target_id)
             WHEN 'comment' THEN (SELECT left(c.body, 140) FROM comments c WHERE c.id::text = m.target_id)
             WHEN 'user' THEN (SELECT u.display_name FROM users u WHERE u.id::text = m.target_id)
             WHEN 'report' THEN (SELECT rp.target_type || ' reported for ' || rp.reason FROM reports rp WHERE rp.id::text = m.target_id)
           END AS label,
           CASE m.target_type
             WHEN 'story' THEN m.target_id
             WHEN 'revision' THEN (SELECT r.story_id::text FROM story_revisions r WHERE r.id::text = m.target_id)
           END AS story_id,
           CASE WHEN m.target_type = 'user' THEN m.target_id END AS user_id,
           CASE WHEN m.target_type = 'comment' THEN (SELECT c.cell FROM comments c WHERE c.id::text = m.target_id) END AS cell
    FROM mod_actions m JOIN users a ON a.id = m.actor_id
    WHERE true
      ${query.actorId ? sql`AND m.actor_id = ${query.actorId}` : sql``}
      ${query.targetType ? sql`AND m.target_type = ${query.targetType}` : sql``}
      ${query.targetId ? sql`AND m.target_id = ${query.targetId}` : sql``}
      ${query.action ? sql`AND (m.action = ${query.action} OR m.action LIKE ${`${query.action}:%`})` : sql``}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit + 1} OFFSET ${query.offset}`;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    actor: { id: r.actorId, displayName: r.actorName },
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    target: { label: r.label, storyId: r.storyId, userId: r.userId, cell: r.cell },
    reason: r.reason,
    details: r.details,
    createdAt: r.createdAt.toISOString(),
  }));
  return { items, nextOffset: rows.length > limit ? query.offset + limit : null };
}
