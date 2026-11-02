import type { Report, ReportReason, ReportTarget } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Sql } from '../db.js';
import { conflict, forbidden, notFound, tooMany } from '../errors.js';
import { POLICY, canReview } from '../policy.js';
import { logModAction } from './modlog.js';

export async function createReport(
  sql: Sql,
  user: SessionUser,
  input: { targetType: ReportTarget; targetId: string; reason: ReportReason; details?: string | null },
): Promise<void> {
  const table = {
    story: 'stories',
    revision: 'story_revisions',
    user: 'users',
    development: 'story_developments',
    correction: 'corrections',
    collection: 'collections',
  }[input.targetType];
  await sql.begin(async (tx) => {
    // Serialise one user's reports so parallel requests can't slip past the daily limit.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
    const [recent] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE reporter_id = ${user.id} AND created_at > now() - interval '1 day'`;
    if ((recent?.n ?? 0) >= POLICY.reportsPerDay) throw tooMany('You have sent a lot of reports today. Thank you! Please try tomorrow.');

    const [exists] = await tx`SELECT 1 FROM ${tx(table)} WHERE id = ${input.targetId}`;
    if (!exists) throw notFound('The reported item');

    const [row] = await tx`
      INSERT INTO reports (target_type, target_id, reporter_id, reason, details)
      VALUES (${input.targetType}, ${input.targetId}, ${user.id}, ${input.reason}, ${input.details ?? null})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (!row) throw conflict('You already reported this. Reviewers will look at it soon.');
  });
}

export async function openReports(sql: Sql): Promise<Report[]> {
  const rows = await sql<
    { id: string; targetType: ReportTarget; targetId: string; reason: ReportReason; details: string | null; createdAt: Date;
      reporterId: string; reporterName: string; label: string | null; storyId: string | null; collectionId: string | null }[]
  >`
    SELECT rp.id, rp.target_type, rp.target_id, rp.reason, rp.details, rp.created_at,
           ru.id AS reporter_id, ru.display_name AS reporter_name,
           CASE rp.target_type
             WHEN 'story' THEN (SELECT r.title FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id WHERE s.id::text = rp.target_id)
             WHEN 'revision' THEN (SELECT r.title FROM story_revisions r WHERE r.id::text = rp.target_id)
             WHEN 'user' THEN (SELECT u.display_name FROM users u WHERE u.id::text = rp.target_id)
             WHEN 'development' THEN (SELECT d.title FROM story_developments d WHERE d.id::text = rp.target_id)
             WHEN 'correction' THEN (SELECT left(c.quote, 140) FROM corrections c WHERE c.id::text = rp.target_id)
             WHEN 'collection' THEN (SELECT c.title FROM collections c WHERE c.id::text = rp.target_id)
           END AS label,
           CASE rp.target_type
             WHEN 'story' THEN rp.target_id
             WHEN 'revision' THEN (SELECT r.story_id::text FROM story_revisions r WHERE r.id::text = rp.target_id)
             WHEN 'development' THEN (SELECT d.story_id::text FROM story_developments d WHERE d.id::text = rp.target_id)
             WHEN 'correction' THEN (SELECT c.story_id::text FROM corrections c WHERE c.id::text = rp.target_id)
           END AS story_id,
           CASE WHEN rp.target_type = 'collection' THEN rp.target_id END AS collection_id
    FROM reports rp JOIN users ru ON ru.id = rp.reporter_id
    WHERE rp.resolved_at IS NULL AND rp.target_type <> 'comment'
    ORDER BY rp.created_at
    LIMIT 100`;
  return rows.map((r) => ({
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    details: r.details,
    reporter: { id: r.reporterId, displayName: r.reporterName },
    createdAt: r.createdAt.toISOString(),
    context: { label: r.label ?? '(deleted)', storyId: r.storyId, collectionId: r.collectionId },
  }));
}

export async function resolveReport(sql: Sql, user: SessionUser, id: string, resolution: 'dismissed' | 'actioned') {
  if (!canReview(user.trustLevel)) throw forbidden();
  await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE reports SET resolved_by = ${user.id}, resolved_at = now(), resolution = ${resolution}
      WHERE id = ${id} AND resolved_at IS NULL
      RETURNING id`;
    if (!row) throw notFound('Report');
    await logModAction(tx, user.id, `report:${resolution}`, 'report', id);
  });
}
