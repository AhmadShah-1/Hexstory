import { TRUST, normalizeQuote, type Correction, type CorrectionProblem, type CorrectionStatus, type Source } from '@hexstory/shared';
import type { z } from 'zod';
import type { createCorrectionSchema, resolveCorrectionSchema } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { POLICY, canReview } from '../policy.js';
import { logModAction } from './modlog.js';
import { assertVisible, closeReportsAbout, fetchStory } from './stories.js';
import { refreshTrust } from './users.js';

type CorrectionData = z.output<typeof createCorrectionSchema>;
type Resolution = z.output<typeof resolveCorrectionSchema>;

interface CorrectionRow {
  id: string;
  storyId: string;
  revisionId: string;
  quote: string;
  problem: CorrectionProblem;
  proposal: string;
  evidence: Source[];
  status: CorrectionStatus;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  resolverId: string | null;
  resolverName: string | null;
  fixedRevisionId: string | null;
  hiddenAt: Date | null;
  authorId: string;
  authorName: string;
  createdAt: Date;
  /** Plain text of the story's current version (title, summary and body), to tell whether the quote is still there. */
  currentText: string | null;
}

/** The text a correction can quote from: title, summary and body of a version. */
const quotableSql = (sql: Db, alias: 'r' | 'cur') =>
  alias === 'r'
    ? sql`concat_ws(' ', r.title, r.summary, r.body)`
    : sql`concat_ws(' ', cur.title, cur.summary, cur.body)`;

const correctionColumns = (sql: Db) => sql`
  c.id, c.story_id, c.revision_id, c.quote, c.problem, c.proposal, c.evidence, c.status, c.resolution_note, c.resolved_at,
  c.fixed_revision_id, c.hidden_at, c.created_at, u.id AS author_id, u.display_name AS author_name,
  ru.id AS resolver_id, ru.display_name AS resolver_name,
  (SELECT ${quotableSql(sql, 'cur')} FROM stories s JOIN story_revisions cur ON cur.id = s.current_revision_id WHERE s.id = c.story_id) AS current_text`;

function toCorrection(r: CorrectionRow): Correction {
  return {
    id: r.id,
    storyId: r.storyId,
    revisionId: r.revisionId,
    quote: r.quote,
    problem: r.problem,
    proposal: r.proposal,
    evidence: r.evidence,
    status: r.status,
    stillInStory: !!r.currentText && normalizeQuote(r.currentText).includes(normalizeQuote(r.quote)),
    author: { id: r.authorId, displayName: r.authorName },
    createdAt: r.createdAt.toISOString(),
    resolution:
      r.status === 'open' || !r.resolvedAt
        ? null
        : {
            note: r.resolutionNote ?? '',
            by: { id: r.resolverId ?? '', displayName: r.resolverName ?? '' },
            at: r.resolvedAt.toISOString(),
            fixedRevisionId: r.fixedRevisionId,
          },
    removed: !!r.hiddenAt,
  };
}

/**
 * Proposes a correction to one statement of a version the reader saw. The quote must appear in that
 * version, so disputes always point at real text; the version itself is never changed.
 */
export async function createCorrection(sql: Sql, user: SessionUser, storyId: string, input: CorrectionData): Promise<{ id: string }> {
  return sql.begin(async (tx) => {
    // Serialise one user's corrections so parallel requests can't slip past the daily limit.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
    const [recent] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM corrections WHERE author_id = ${user.id} AND created_at > now() - interval '1 day'`;
    const limit = POLICY.correctionsPerDay[user.trustLevel];
    if ((recent?.n ?? 0) >= limit) throw tooMany(`You've reached today's limit of ${limit} corrections. Thank you! Please try tomorrow.`);

    const story = await fetchStory(tx, storyId);
    assertVisible(story, user);
    if (story.status !== 'active') throw conflict('Corrections can be proposed once a story is published.');
    const [rev] = await tx<{ text: string; status: string; hiddenAt: Date | null }[]>`
      SELECT ${quotableSql(tx, 'r')} AS text, r.status, r.hidden_at FROM story_revisions r WHERE r.id = ${input.revisionId} AND r.story_id = ${storyId}`;
    if (!rev || rev.status !== 'accepted' || rev.hiddenAt) throw notFound('Version');
    if (!normalizeQuote(rev.text).includes(normalizeQuote(input.quote))) {
      throw badRequest('Quote the statement exactly as it appears in the story.', 'quote-not-found');
    }
    const [dupe] = await tx`
      SELECT 1 FROM corrections WHERE story_id = ${storyId} AND author_id = ${user.id} AND status = 'open' AND hidden_at IS NULL
        AND quote = ${input.quote}`;
    if (dupe) throw conflict('You already disputed this statement. Reviewers will look at it soon.');
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO corrections (story_id, revision_id, author_id, quote, problem, proposal, evidence)
      VALUES (${storyId}, ${input.revisionId}, ${user.id}, ${input.quote}, ${input.problem}, ${input.proposal},
        ${tx.json(input.evidence.map((s) => ({ title: s.title, url: s.url ?? null })))})
      RETURNING id`;
    return { id: row!.id };
  });
}

/** A story's corrections: open ones first, then decided ones, newest first. Removed ones for reviewers only. */
export async function listCorrections(sql: Sql, storyId: string, viewer: SessionUser | null): Promise<Correction[]> {
  const story = await fetchStory(sql, storyId);
  assertVisible(story, viewer);
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  const rows = await sql<CorrectionRow[]>`
    SELECT ${correctionColumns(sql)}
    FROM corrections c JOIN users u ON u.id = c.author_id LEFT JOIN users ru ON ru.id = c.resolved_by
    WHERE c.story_id = ${storyId} AND (c.hidden_at IS NULL OR ${reviewer})
    ORDER BY (c.status = 'open') DESC, COALESCE(c.resolved_at, c.created_at) DESC
    LIMIT 200`;
  return rows.map(toCorrection);
}

/**
 * Reviewers decide a correction with a public note. Accepting doesn't edit the story by itself: the fix is
 * made as a normal edit (whose version can be linked as `fixedRevisionId`), so the history shows both the
 * disputed version and the corrected one. Nobody decides their own correction, and only moderators decide
 * corrections to stories they started.
 */
export async function resolveCorrection(sql: Sql, user: SessionUser, id: string, input: Resolution): Promise<void> {
  if (!canReview(user.trustLevel)) throw forbidden();
  const affected = await sql.begin(async (tx) => {
    const [c] = await tx<{ storyId: string; authorId: string; status: CorrectionStatus; hiddenAt: Date | null; storyCreator: string }[]>`
      SELECT c.story_id, c.author_id, c.status, c.hidden_at, s.created_by AS story_creator
      FROM corrections c JOIN stories s ON s.id = c.story_id WHERE c.id = ${id} FOR UPDATE OF c`;
    if (!c || c.hiddenAt) throw notFound('Correction');
    if (c.status !== 'open') throw conflict('This correction was already decided.', 'already-decided');
    if (c.authorId === user.id) throw forbidden('You cannot decide your own correction.');
    if (c.storyCreator === user.id && user.trustLevel < TRUST.MODERATOR) {
      throw forbidden('Another reviewer should decide corrections to a story you started.');
    }
    if (input.fixedRevisionId) {
      const [fix] = await tx`
        SELECT 1 FROM story_revisions WHERE id = ${input.fixedRevisionId} AND story_id = ${c.storyId} AND status = 'accepted' AND hidden_at IS NULL`;
      if (!fix) throw badRequest('That version is not an accepted version of this story.');
    }
    await tx`
      UPDATE corrections SET status = ${input.decision}, resolution_note = ${input.note}, resolved_by = ${user.id}, resolved_at = now(),
        fixed_revision_id = ${input.decision === 'accepted' ? input.fixedRevisionId ?? null : null}
      WHERE id = ${id}`;
    await logModAction(tx, user.id, `correction:${input.decision}`, 'correction', id, input.note);
    return [c.authorId, c.storyCreator];
  });
  for (const userId of new Set(affected)) await refreshTrust(sql, userId);
}

/**
 * Reviewers remove an abusive correction. It stays visible to reviewers only. The same people who may not
 * decide a correction may not remove it (its author; the story's creator unless a moderator), and only
 * moderators remove one already decided, so removal can't be used to bury a dispute or undo its points.
 */
export async function removeCorrection(sql: Sql, user: SessionUser, id: string, reason: string | null): Promise<void> {
  if (!canReview(user.trustLevel)) throw forbidden();
  const affected = await sql.begin(async (tx) => {
    const [c] = await tx<{ authorId: string; status: CorrectionStatus; hiddenAt: Date | null; storyCreator: string }[]>`
      SELECT c.author_id, c.status, c.hidden_at, s.created_by AS story_creator
      FROM corrections c JOIN stories s ON s.id = c.story_id WHERE c.id = ${id} FOR UPDATE OF c`;
    if (!c || c.hiddenAt) throw notFound('Correction');
    const moderator = user.trustLevel >= TRUST.MODERATOR;
    if (c.authorId === user.id) throw forbidden('You cannot remove your own correction.');
    if (c.storyCreator === user.id && !moderator) throw forbidden('Another reviewer should handle corrections to a story you started.');
    if (c.status !== 'open' && !moderator) throw forbidden('Only a moderator can remove a correction that was already decided.');
    await tx`UPDATE corrections SET hidden_at = now() WHERE id = ${id}`;
    await closeReportsAbout(tx, user.id, 'correction', [id]);
    await logModAction(tx, user.id, 'remove-correction', 'correction', id, reason);
    return [c.authorId, c.storyCreator];
  });
  for (const userId of new Set(affected)) await refreshTrust(sql, userId);
}

/** Open corrections for the Watchtower, oldest first (not about hidden stories or from banned people). */
export async function openCorrections(sql: Sql): Promise<(Correction & { storyTitle: string; storyCreatedBy: string })[]> {
  const rows = await sql<(CorrectionRow & { storyTitle: string; storyCreatedBy: string })[]>`
    SELECT ${correctionColumns(sql)}, cur.title AS story_title, s.created_by AS story_created_by
    FROM corrections c
    JOIN users u ON u.id = c.author_id
    LEFT JOIN users ru ON ru.id = c.resolved_by
    JOIN stories s ON s.id = c.story_id
    JOIN story_revisions cur ON cur.id = s.current_revision_id
    WHERE c.status = 'open' AND c.hidden_at IS NULL AND u.banned_at IS NULL AND s.status = 'active'
    ORDER BY c.created_at
    LIMIT 50`;
  return rows.map((r) => ({ ...toCorrection(r), storyTitle: r.storyTitle, storyCreatedBy: r.storyCreatedBy }));
}
