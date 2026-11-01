import {
  LIMITS,
  TRUST,
  baseCellCount,
  compact,
  docImageKeys,
  docLinkCount,
  docToPlainText,
  indexCells,
  legacyDoc,
  toBaseCells,
  uncompact,
  type CellCount,
  type ContributionEdit,
  type ContributionStory,
  type CreateStoryInput,
  type EditStoryInput,
  type Page,
  type RevisionListItem,
  type RevisionStatus,
  type RichDoc,
  type StoryDetail,
  type StoryRevision,
  type StoryStatus,
  type StorySummary,
  type TrustLevel,
  type UnreviewedStory,
  type WriteResult,
} from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { POLICY, canReview, detectFlags, liveEditThreshold } from '../policy.js';
import { imageFileNames, type Storage } from '../storage/index.js';
import { logModAction } from './modlog.js';
import { refreshTrust } from './users.js';

export interface StoryDeps {
  sql: Sql;
  storage: Storage;
}

interface RevisionRow {
  id: string;
  storyId: string;
  parentRevisionId: string | null;
  authorId: string;
  authorName: string;
  title: string;
  body: string;
  imageKey: string | null;
  imageCredit: string | null;
  content: RichDoc | null;
  cells: string[];
  startYear: number;
  startMonth: number | null;
  startDay: number | null;
  endYear: number | null;
  endMonth: number | null;
  endDay: number | null;
  isOngoing: boolean;
  isApprox: boolean;
  sources: StoryRevision['sources'];
  status: RevisionStatus;
  editSummary: string | null;
  flags: string[];
  hiddenAt: Date | null;
  createdAt: Date;
}

export interface StoryRow {
  id: string;
  currentRevisionId: string | null;
  status: StoryStatus;
  protectionLevel: TrustLevel;
  cellCount: number;
  createdBy: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Mapping

function imageUrls(storage: Storage, key: string | null) {
  if (!key) return { imageUrl: null, thumbUrl: null };
  const names = imageFileNames(key);
  return { imageUrl: storage.publicUrl(names.full), thumbUrl: storage.publicUrl(names.thumb) };
}

const datesOf = (r: Pick<RevisionRow, 'startYear' | 'startMonth' | 'startDay' | 'endYear' | 'endMonth' | 'endDay'>) => ({
  start: { year: r.startYear, month: r.startMonth, day: r.startDay },
  end: r.endYear === null ? null : { year: r.endYear, month: r.endMonth, day: r.endDay },
});

/** Adds a public URL to every image block so clients never construct storage paths themselves. */
function withImageUrls(storage: Storage, doc: RichDoc): RichDoc {
  return doc.map((b) => (b.type === 'image' ? { ...b, url: storage.publicUrl(imageFileNames(b.key).full) } : b));
}

function toRevision(storage: Storage, r: RevisionRow): StoryRevision {
  return {
    id: r.id,
    storyId: r.storyId,
    parentRevisionId: r.parentRevisionId,
    author: { id: r.authorId, displayName: r.authorName },
    title: r.title,
    body: r.body,
    content: withImageUrls(storage, r.content ?? legacyDoc(r.body, r.imageKey, r.imageCredit)),
    thumbUrl: imageUrls(storage, r.imageKey).thumbUrl,
    cells: r.cells,
    ...datesOf(r),
    isOngoing: r.isOngoing,
    isApprox: r.isApprox,
    sources: r.sources,
    status: r.status,
    editSummary: r.editSummary,
    flags: r.flags,
    removed: !!r.hiddenAt,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `where` is a fragment placed after WHERE; it may also carry ORDER BY / LIMIT. */
async function fetchRevisions(sql: Db, where: ReturnType<Db>): Promise<RevisionRow[]> {
  return sql<RevisionRow[]>`
    SELECT r.id, r.story_id, r.parent_revision_id, r.author_id, u.display_name AS author_name,
           r.title, r.body, r.content, r.image_key, r.image_credit, r.cells,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day,
           r.is_ongoing, r.is_approx, r.sources, r.status, r.edit_summary, r.flags, r.hidden_at, r.created_at
    FROM story_revisions r JOIN users u ON u.id = r.author_id
    WHERE ${where}`;
}

async function fetchRevision(sql: Db, id: string): Promise<RevisionRow | undefined> {
  const [row] = await fetchRevisions(sql, sql`r.id = ${id}`);
  return row;
}

export async function fetchStory(sql: Db, id: string, lock = false): Promise<StoryRow | undefined> {
  const [row] = lock
    ? await sql<StoryRow[]>`SELECT * FROM stories WHERE id = ${id} FOR UPDATE`
    : await sql<StoryRow[]>`SELECT * FROM stories WHERE id = ${id}`;
  return row;
}

// ---------------------------------------------------------------------------------------------
// Map counts (cached briefly; every zoom change asks for them)

const COUNT_TTL_MS = 10_000;
const countCache = new Map<number, { at: number; data: CellCount[] }>();

export function invalidateCellCounts(): void {
  countCache.clear();
}

export async function cellCounts(sql: Sql, res: number): Promise<CellCount[]> {
  const cached = countCache.get(res);
  if (cached && Date.now() - cached.at < COUNT_TTL_MS) return cached.data;
  const data = await sql<CellCount[]>`
    SELECT c.cell, count(*)::int AS count
    FROM story_cells c JOIN stories s ON s.id = c.story_id
    WHERE c.res = ${res} AND s.status = 'active'
    GROUP BY c.cell`;
  countCache.set(res, { at: Date.now(), data: [...data] });
  return data;
}

// ---------------------------------------------------------------------------------------------
// Reading

/**
 * Published stories in a cell, plus the ones waiting for approval that this viewer may see (their own,
 * or all of them for reviewers), so a newcomer finds the story they just wrote where they put it.
 */
export async function listStoriesInCell(
  { sql, storage }: StoryDeps,
  cell: string,
  offset: number,
  viewer: SessionUser | null,
  limit = 30,
): Promise<Page<StorySummary>> {
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  const rows = await sql<SummaryRow[]>`
    SELECT s.id AS story_id, s.status AS story_status, s.cell_count, r.title, r.image_key, r.source_count,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day,
           r.is_ongoing, r.is_approx
    FROM story_cells c
    JOIN stories s ON s.id = c.story_id
    JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE c.cell = ${cell}
      AND (s.status = 'active' OR (s.status = 'unreviewed' AND (${reviewer} OR s.created_by = ${viewer?.id ?? null})))
    ORDER BY r.is_ongoing DESC, r.sort_key DESC, s.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  return { items: rows.slice(0, limit).map((r) => toSummary(storage, r)), nextOffset: rows.length > limit ? offset + limit : null };
}

function permissions(story: StoryRow, viewer: SessionUser | null): StoryDetail['can'] {
  if (!viewer || viewer.bannedAt) return { edit: false, editGoesLive: false, review: false };
  // A story whose first version is still held can't be edited until that version is reviewed.
  if (!story.currentRevisionId) return { edit: false, editGoesLive: false, review: canReview(viewer.trustLevel) };
  const isCreatorOfUnreviewed =
    viewer.id === story.createdBy && story.status === 'unreviewed' && story.protectionLevel === TRUST.NEW;
  return {
    edit: story.status !== 'hidden' || canReview(viewer.trustLevel),
    editGoesLive: viewer.trustLevel >= liveEditThreshold(story.protectionLevel) || isCreatorOfUnreviewed,
    review: canReview(viewer.trustLevel),
  };
}

const canSeeUnaccepted = (viewer: SessionUser | null, authorId: string) =>
  !!viewer && (canReview(viewer.trustLevel) || viewer.id === authorId);

/**
 * Published stories are public. A story waiting for approval (or whose first version is held) is
 * visible only to the person who started it and to reviewers; hidden stories only to reviewers.
 */
function canSeeStory(story: StoryRow, viewer: SessionUser | null): boolean {
  if (viewer && canReview(viewer.trustLevel)) return true;
  if (story.status === 'hidden') return false;
  if (story.status === 'active' && story.currentRevisionId) return true;
  return !!viewer && viewer.id === story.createdBy;
}

function assertVisible(story: StoryRow | undefined, viewer: SessionUser | null): asserts story is StoryRow {
  if (!story || !canSeeStory(story, viewer)) throw notFound('Story');
}

/** Removed versions are kept for the record but shown only to reviewers. */
function canSeeRevision(r: { status: RevisionStatus; authorId: string; hiddenAt: Date | null }, viewer: SessionUser | null): boolean {
  if (r.hiddenAt) return !!viewer && canReview(viewer.trustLevel);
  return r.status === 'accepted' || canSeeUnaccepted(viewer, r.authorId);
}

export async function getStory({ sql, storage }: StoryDeps, id: string, viewer: SessionUser | null): Promise<StoryDetail> {
  const story = await fetchStory(sql, id);
  assertVisible(story, viewer);

  // A story whose first revision is still pending has no current revision; reviewers see the pending one.
  const [revision] = story.currentRevisionId
    ? await fetchRevisions(sql, sql`r.id = ${story.currentRevisionId}`)
    : await fetchRevisions(sql, sql`r.story_id = ${id} ORDER BY r.created_at LIMIT 1`);
  if (!revision) throw notFound('Story');
  const [counts] = await sql<{ pending: number; creatorName: string }[]>`
    SELECT (SELECT count(*)::int FROM story_revisions WHERE story_id = ${id} AND status = 'pending') AS pending,
           (SELECT display_name FROM users WHERE id = ${story.createdBy}) AS creator_name`;

  return {
    id: story.id,
    status: story.status,
    protectionLevel: story.protectionLevel,
    createdAt: story.createdAt.toISOString(),
    createdBy: { id: story.createdBy, displayName: counts?.creatorName ?? '' },
    revision: toRevision(storage, revision),
    cellCount: story.cellCount,
    pendingCount: counts?.pending ?? 0,
    can: permissions(story, viewer),
  };
}

export async function listRevisions(sql: Sql, storyId: string, viewer: SessionUser | null): Promise<RevisionListItem[]> {
  const story = await fetchStory(sql, storyId);
  assertVisible(story, viewer);
  const rows = await sql<
    { id: string; authorId: string; authorName: string; status: RevisionStatus; editSummary: string | null; flags: string[];
      hiddenAt: Date | null; createdAt: Date }[]
  >`
    SELECT r.id, r.author_id, u.display_name AS author_name, r.status, r.edit_summary, r.flags, r.hidden_at, r.created_at
    FROM story_revisions r JOIN users u ON u.id = r.author_id
    WHERE r.story_id = ${storyId}
    ORDER BY r.created_at DESC
    LIMIT 200`;
  return rows.filter((r) => canSeeRevision(r, viewer)).map((r) => ({
    id: r.id,
    author: { id: r.authorId, displayName: r.authorName },
    status: r.status,
    editSummary: r.editSummary,
    flags: r.flags,
    isCurrent: r.id === story.currentRevisionId,
    removed: !!r.hiddenAt,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getRevision({ sql, storage }: StoryDeps, id: string, viewer: SessionUser | null): Promise<StoryRevision> {
  const revision = await fetchRevision(sql, id);
  if (!revision) throw notFound('Version');
  const story = await fetchStory(sql, revision.storyId);
  assertVisible(story, viewer);
  // Versions that never went live (pending or rejected) may contain abuse; only reviewers and the author
  // see them. Removed versions only reviewers.
  if (!canSeeRevision(revision, viewer)) throw notFound('Version');
  return toRevision(storage, revision);
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Points the story at a revision and rebuilds its cell index. */
export async function applyRevision(tx: Db, storyId: string, revision: { id: string; cells: string[] }): Promise<void> {
  const baseCells = uncompact(revision.cells);
  const rows = indexCells(baseCells).map(({ res, cell }) => ({ storyId, res, cell }));
  await tx`
    UPDATE stories SET current_revision_id = ${revision.id}, cell_count = ${baseCells.length}, updated_at = now()
    WHERE id = ${storyId}`;
  await tx`DELETE FROM story_cells WHERE story_id = ${storyId}`;
  for (let i = 0; i < rows.length; i += 5_000) {
    const chunk = rows.slice(i, i + 5_000).map((r) => [r.storyId, r.res, r.cell]);
    await tx`INSERT INTO story_cells (story_id, res, cell) VALUES ${tx(chunk)}`;
  }
  invalidateCellCounts();
}

async function prepareContent(storage: Storage, input: CreateStoryInput) {
  // Count before expanding: a few thousand coarse cells would otherwise expand to millions.
  if (baseCellCount(input.cells) > LIMITS.cellsMax) {
    throw badRequest('That area is too large. Select fewer or smaller regions.', 'area-too-large');
  }
  const baseCells = toBaseCells([...new Set(input.cells)]);
  for (const key of new Set(docImageKeys(input.content))) {
    if (!(await storage.exists(imageFileNames(key).full))) {
      throw badRequest('One of the images was not found. Please upload it again.');
    }
  }
  const firstImage = input.content.find((b) => b.type === 'image');
  return {
    title: input.title,
    body: docToPlainText(input.content),
    content: input.content,
    // The first image doubles as the story's thumbnail in lists.
    image_key: firstImage?.key ?? null,
    image_credit: firstImage?.caption ?? null,
    cells: compact(baseCells).sort(),
    start_year: input.start.year,
    start_month: input.start.month ?? null,
    start_day: input.start.day ?? null,
    end_year: input.end?.year ?? null,
    end_month: input.end?.month ?? null,
    end_day: input.end?.day ?? null,
    is_ongoing: input.isOngoing,
    is_approx: input.isApprox,
    sources: input.sources.map((s) => ({ title: s.title, url: s.url ?? null })),
  };
}
type Content = Awaited<ReturnType<typeof prepareContent>>;

async function insertRevision(
  tx: Db,
  fields: Content & { story_id: string; parent_revision_id: string | null; author_id: string; status: RevisionStatus; edit_summary: string | null; flags: string[] },
): Promise<string> {
  // postgres.js serialises the sources array for the jsonb column itself.
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO story_revisions ${tx(fields as Record<string, unknown>)}
    RETURNING id`;
  return row!.id;
}

/**
 * Must run inside the transaction that inserts. The per-user advisory lock serialises concurrent
 * writes from one user so parallel requests can't all pass the count.
 */
async function assertWithinDailyLimit(sql: Db, user: SessionUser, kind: 'stories' | 'edits'): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
  const limit = kind === 'stories' ? POLICY.storiesPerDay[user.trustLevel] : POLICY.editsPerDay[user.trustLevel];
  const [row] =
    kind === 'stories'
      ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM stories WHERE created_by = ${user.id} AND created_at > now() - interval '1 day'`
      : await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM story_revisions WHERE author_id = ${user.id} AND created_at > now() - interval '1 day'`;
  if ((row?.n ?? 0) >= limit) {
    throw tooMany(`You've reached today's limit of ${limit} ${kind === 'stories' ? 'new stories' : 'edits'}. It grows as you contribute.`);
  }
}

export async function createStory({ sql, storage }: StoryDeps, user: SessionUser, input: CreateStoryInput): Promise<WriteResult> {
  const content = await prepareContent(storage, input);
  const flags = detectFlags({ previousBody: null, body: content.body, links: docLinkCount(content.content), trustLevel: user.trustLevel });
  const held = flags.length > 0 && !canReview(user.trustLevel);

  // A newcomer's story stays private (to them and reviewers) until a reviewer approves it.
  const storyStatus: StoryStatus = user.trustLevel >= TRUST.MEMBER ? 'active' : 'unreviewed';

  const result = await sql.begin(async (tx) => {
    await assertWithinDailyLimit(tx, user, 'stories');
    const [story] = await tx<{ id: string }[]>`
      INSERT INTO stories (status, created_by)
      VALUES (${storyStatus}, ${user.id})
      RETURNING id`;
    const storyId = story!.id;
    const revisionId = await insertRevision(tx, {
      ...content,
      story_id: storyId,
      parent_revision_id: null,
      author_id: user.id,
      status: held ? 'pending' : 'accepted',
      edit_summary: null,
      flags,
    });
    if (!held) await applyRevision(tx, storyId, { id: revisionId, cells: content.cells });
    return { storyId, revisionId, status: held ? 'pending' : 'live', storyStatus } as const;
  });
  if (!held) await refreshTrust(sql, user.id);
  return result;
}

const sameContent = (a: Content, b: RevisionRow) =>
  JSON.stringify([a.title, a.content, a.cells, a.start_year, a.start_month, a.start_day,
    a.end_year, a.end_month, a.end_day, a.is_ongoing, a.is_approx, a.sources]) ===
  JSON.stringify([b.title, b.content ?? legacyDoc(b.body, b.imageKey, b.imageCredit), [...b.cells].sort(), b.startYear, b.startMonth, b.startDay,
    b.endYear, b.endMonth, b.endDay, b.isOngoing, b.isApprox, b.sources.map((s) => ({ title: s.title, url: s.url ?? null }))]);

export async function editStory(
  { sql, storage }: StoryDeps,
  user: SessionUser,
  storyId: string,
  input: EditStoryInput,
): Promise<WriteResult> {
  const content = await prepareContent(storage, input);

  const result = await sql.begin(async (tx) => {
    await assertWithinDailyLimit(tx, user, 'edits');
    const story = await fetchStory(tx, storyId, true);
    assertVisible(story, user);
    if (!story.currentRevisionId) throw conflict('This story is still waiting for its first review.');
    if (story.currentRevisionId !== input.baseRevisionId) {
      throw conflict('Someone changed this story while you were editing. Copy your text, reload, and try again.', 'stale');
    }
    const current = await fetchRevision(tx, story.currentRevisionId);
    if (!current) throw notFound('Story');
    if (sameContent(content, current)) throw badRequest('Nothing changed.', 'no-changes');

    const can = permissions(story, user);
    if (!can.edit) throw forbidden();
    const flags = detectFlags({
      previousBody: current.body,
      body: content.body,
      links: docLinkCount(content.content),
      trustLevel: user.trustLevel,
    });
    const live = can.editGoesLive && (flags.length === 0 || canReview(user.trustLevel));

    const revisionId = await insertRevision(tx, {
      ...content,
      story_id: storyId,
      parent_revision_id: current.id,
      author_id: user.id,
      status: live ? 'accepted' : 'pending',
      edit_summary: input.editSummary ?? null,
      flags,
    });
    if (live) await applyRevision(tx, storyId, { id: revisionId, cells: content.cells });
    return { storyId, revisionId, status: live ? 'live' : 'pending', storyStatus: story.status } as const;
  });
  if (result.status === 'live') await refreshTrust(sql, user.id);
  return result;
}

export async function reviewRevision(
  sql: Sql,
  user: SessionUser,
  revisionId: string,
  decision: 'accept' | 'reject',
  reason: string | null,
): Promise<void> {
  if (!canReview(user.trustLevel)) throw forbidden();
  const authorId = await sql.begin(async (tx) => {
    const [rev] = await tx<{ id: string; storyId: string; parentRevisionId: string | null; authorId: string; status: string; cells: string[] }[]>`
      SELECT id, story_id, parent_revision_id, author_id, status, cells FROM story_revisions WHERE id = ${revisionId} FOR UPDATE`;
    if (!rev) throw notFound('Version');
    if (rev.status !== 'pending') throw conflict('This version was already reviewed.');
    if (rev.authorId === user.id) throw forbidden('You cannot review your own changes.');

    if (decision === 'accept') {
      const story = await fetchStory(tx, rev.storyId, true);
      if (!story) throw notFound('Story');
      if (story.currentRevisionId !== rev.parentRevisionId) {
        throw conflict('The story changed after this edit was made. Reject it and let the author resubmit.', 'stale');
      }
      await applyRevision(tx, rev.storyId, rev);
      // Accepting the first version of a story waiting for approval is approving the story: the
      // reviewer has just read all of it.
      if (story.status === 'unreviewed' && rev.parentRevisionId === null) {
        await tx`UPDATE stories SET status = 'active' WHERE id = ${rev.storyId}`;
        await logModAction(tx, user.id, 'approve', 'story', rev.storyId, reason);
      }
    }
    await tx`
      UPDATE story_revisions SET status = ${decision === 'accept' ? 'accepted' : 'rejected'},
        reviewed_by = ${user.id}, reviewed_at = now()
      WHERE id = ${revisionId}`;
    await logModAction(tx, user.id, decision, 'revision', revisionId, reason);
    return rev.authorId;
  });
  invalidateCellCounts();
  await refreshTrust(sql, authorId);
}

/**
 * Copies an earlier version into a new current revision, so history stays linear and append-only.
 * The caller holds the story's row lock.
 */
export async function copyToNewRevision(tx: Db, story: StoryRow, sourceId: string, actorId: string, summary: string): Promise<string> {
  const [row] = await tx<{ id: string; cells: string[] }[]>`
    INSERT INTO story_revisions (story_id, parent_revision_id, author_id, title, body, content, image_key, image_credit, cells,
      start_year, start_month, start_day, end_year, end_month, end_day, is_ongoing, is_approx, sources,
      status, edit_summary, reviewed_by, reviewed_at)
    SELECT story_id, ${story.currentRevisionId}, ${actorId}, title, body, content, image_key, image_credit, cells,
      start_year, start_month, start_day, end_year, end_month, end_day, is_ongoing, is_approx, sources,
      'accepted', ${summary}, ${actorId}, now()
    FROM story_revisions WHERE id = ${sourceId} AND story_id = ${story.id}
    RETURNING id, cells`;
  if (!row) throw notFound('Version');
  await applyRevision(tx, story.id, row);
  return row.id;
}

export async function restoreRevision({ sql }: StoryDeps, user: SessionUser, storyId: string, revisionId: string): Promise<WriteResult> {
  if (!canReview(user.trustLevel)) throw forbidden();
  return sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (user.trustLevel < liveEditThreshold(story.protectionLevel)) throw forbidden('This story is protected.');
    const old = await fetchRevision(tx, revisionId);
    // Removed versions are out of the history for good.
    if (!old || old.storyId !== storyId || old.hiddenAt) throw notFound('Version');
    // Only versions that were live once can be restored; pending ones go through review instead.
    if (old.status !== 'accepted') throw badRequest('Only versions that were accepted can be restored.');
    if (old.id === story.currentRevisionId) throw badRequest('That is already the current version.');

    const newId = await copyToNewRevision(tx, story, revisionId, user.id, `Restored the version from ${old.createdAt.toISOString().slice(0, 10)}`);
    await logModAction(tx, user.id, 'restore', 'story', storyId, null, { revisionId });
    return { storyId, revisionId: newId, status: 'live', storyStatus: story.status } as const;
  });
}

/**
 * Approve (publish) a story waiting for review, hide a story, or (moderators) bring a hidden one back.
 * `revisionId` is the version the reviewer read: approval fails if the author changed it since.
 */
export async function setStoryStatus(
  sql: Sql,
  user: SessionUser,
  storyId: string,
  status: 'active' | 'hidden',
  reason: string | null,
  revisionId?: string | null,
) {
  if (!canReview(user.trustLevel)) throw forbidden();
  const approvedCreator = await sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (story.status === 'hidden' && status === 'active') {
      if (user.trustLevel < TRUST.MODERATOR) throw forbidden('Only moderators can bring back a hidden story.');
      const [current] = await tx<{ hiddenAt: Date | null }[]>`SELECT hidden_at FROM story_revisions WHERE id = ${story.currentRevisionId}`;
      if (current?.hiddenAt) throw conflict('Its current version was removed. Restore another version before bringing it back.');
    }
    const approving = story.status === 'unreviewed' && status === 'active';
    if (approving) {
      if (!story.currentRevisionId) {
        throw conflict('Its first version is still waiting for review. Accept that version to publish the story.');
      }
      if (story.createdBy === user.id) throw forbidden('You cannot approve your own story.');
      if (revisionId && revisionId !== story.currentRevisionId) {
        throw conflict('The author changed this story after you opened it. Take another look before approving.', 'stale');
      }
    }
    await tx`UPDATE stories SET status = ${status}, updated_at = now() WHERE id = ${storyId}`;
    const action = status === 'hidden' ? 'hide' : story.status === 'hidden' ? 'unhide' : 'approve';
    await logModAction(tx, user.id, action, 'story', storyId, reason);
    return approving ? story.createdBy : null;
  });
  invalidateCellCounts();
  // Contributions only count toward promotion once the story is published.
  if (approvedCreator) await refreshTrust(sql, approvedCreator);
}

/**
 * Removes a version from the history (e.g. it exposed someone's personal details), or (moderators)
 * puts it back. A removed version can't be viewed publicly or restored. The current version can't be
 * removed: restore an earlier one first.
 */
export async function setRevisionRemoved(sql: Sql, user: SessionUser, revisionId: string, removed: boolean, reason: string | null) {
  if (!canReview(user.trustLevel)) throw forbidden();
  if (!removed && user.trustLevel < TRUST.MODERATOR) throw forbidden('Only moderators can put back a removed version.');
  await sql.begin(async (tx) => {
    const [rev] = await tx<{ id: string; storyId: string; status: RevisionStatus; hiddenAt: Date | null }[]>`
      SELECT id, story_id, status, hidden_at FROM story_revisions WHERE id = ${revisionId} FOR UPDATE`;
    if (!rev) throw notFound('Version');
    const story = await fetchStory(tx, rev.storyId, true);
    if (removed) {
      if (rev.hiddenAt) throw conflict('This version was already removed.');
      if (story?.currentRevisionId === rev.id) {
        throw conflict("This is the story's current version. Restore an earlier version first, then remove this one.");
      }
      await tx`
        UPDATE story_revisions SET hidden_at = now(),
          status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END,
          reviewed_by = CASE WHEN status = 'pending' THEN ${user.id}::uuid ELSE reviewed_by END,
          reviewed_at = CASE WHEN status = 'pending' THEN now() ELSE reviewed_at END
        WHERE id = ${revisionId}`;
      await closeReportsAbout(tx, user.id, 'revision', [revisionId]);
    } else {
      if (!rev.hiddenAt) throw conflict('This version is not removed.');
      await tx`UPDATE story_revisions SET hidden_at = NULL WHERE id = ${revisionId}`;
    }
    await logModAction(tx, user.id, removed ? 'remove-version' : 'restore-version', 'revision', revisionId, reason);
  });
}

/** Marks open reports about these items as handled (the item was dealt with). Returns how many. */
export async function closeReportsAbout(tx: Db, actorId: string, targetType: 'story' | 'revision' | 'comment' | 'user', ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await tx`
    UPDATE reports SET resolved_by = ${actorId}, resolved_at = now(), resolution = 'actioned'
    WHERE resolved_at IS NULL AND target_type = ${targetType} AND target_id IN ${tx(ids)}
    RETURNING id`;
  return rows.length;
}

export async function setProtection(sql: Sql, user: SessionUser, storyId: string, level: TrustLevel) {
  if (user.trustLevel < TRUST.MODERATOR) throw forbidden();
  await sql.begin(async (tx) => {
    const [row] = await tx`UPDATE stories SET protection_level = ${level} WHERE id = ${storyId} RETURNING id`;
    if (!row) throw notFound('Story');
    await logModAction(tx, user.id, `protect:${level}`, 'story', storyId);
  });
}

export async function pendingForReview({ sql, storage }: StoryDeps) {
  const pending = await fetchRevisions(sql, sql`r.status = 'pending' AND r.hidden_at IS NULL ORDER BY r.created_at LIMIT 50`);
  const parentIds = pending.map((r) => r.parentRevisionId).filter((id): id is string => !!id);
  const parents = parentIds.length ? await fetchRevisions(sql, sql`r.id IN ${sql(parentIds)}`) : [];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return pending.map((r) => ({
    revision: toRevision(storage, r),
    currentRevision: r.parentRevisionId && byId.has(r.parentRevisionId) ? toRevision(storage, byId.get(r.parentRevisionId)!) : null,
  }));
}

type SummaryRow = Pick<RevisionRow, 'title' | 'imageKey' | 'startYear' | 'startMonth' | 'startDay' | 'endYear' | 'endMonth' | 'endDay' | 'isOngoing' | 'isApprox'> & {
  storyId: string;
  storyStatus: StoryStatus;
  cellCount: number;
  sourceCount: number;
};

function toSummary(storage: Storage, r: SummaryRow): StorySummary {
  return {
    id: r.storyId,
    title: r.title,
    thumbUrl: imageUrls(storage, r.imageKey).thumbUrl,
    ...datesOf(r),
    isOngoing: r.isOngoing,
    isApprox: r.isApprox,
    sourceCount: r.sourceCount,
    cellCount: r.cellCount,
    status: r.storyStatus,
  };
}

/** Newcomers' stories waiting for a reviewer to approve them, oldest first. */
export async function unreviewedStories({ sql, storage }: StoryDeps): Promise<UnreviewedStory[]> {
  const rows = await sql<(SummaryRow & { revisionId: string; authorId: string; authorName: string; excerpt: string; createdAt: Date })[]>`
    SELECT s.id AS story_id, s.status AS story_status, s.cell_count, s.created_at, r.id AS revision_id, r.title, r.image_key, r.source_count,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day, r.is_ongoing, r.is_approx,
           left(r.body, 280) AS excerpt, u.id AS author_id, u.display_name AS author_name
    FROM stories s
    JOIN story_revisions r ON r.id = s.current_revision_id
    JOIN users u ON u.id = s.created_by
    WHERE s.status = 'unreviewed'
    ORDER BY s.created_at
    LIMIT 50`;
  return rows.map((r) => ({
    story: toSummary(storage, r),
    author: { id: r.authorId, displayName: r.authorName },
    revisionId: r.revisionId,
    excerpt: r.excerpt,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------------------------
// Contributions (the user themself and reviewers only; access is checked by the caller)

/** Stories a user started, newest first, including ones that are not public. */
export async function storiesStartedBy({ sql, storage }: StoryDeps, userId: string, offset: number, limit = 30): Promise<Page<ContributionStory>> {
  const rows = await sql<(SummaryRow & { createdAt: Date; hasCurrent: boolean; revisionStatus: RevisionStatus })[]>`
    SELECT s.id AS story_id, s.status AS story_status, s.cell_count, s.created_at, s.current_revision_id IS NOT NULL AS has_current,
           r.status AS revision_status, r.title, r.image_key, r.source_count,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day, r.is_ongoing, r.is_approx
    FROM stories s
    JOIN story_revisions r ON r.id = COALESCE(s.current_revision_id,
      (SELECT f.id FROM story_revisions f WHERE f.story_id = s.id ORDER BY f.created_at LIMIT 1))
    WHERE s.created_by = ${userId}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const items = rows.slice(0, limit).map((r) => ({
    story: toSummary(storage, r),
    state:
      r.storyStatus === 'hidden' ? ('hidden' as const)
      : !r.hasCurrent && r.revisionStatus === 'rejected' ? ('rejected' as const)
      : r.storyStatus === 'active' && r.hasCurrent ? ('live' as const)
      : ('waiting' as const),
    createdAt: r.createdAt.toISOString(),
  }));
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}

/** Every version a user wrote, newest first. */
export async function revisionsBy(sql: Sql, userId: string, offset: number, limit = 50): Promise<Page<ContributionEdit>> {
  const rows = await sql<
    { id: string; storyId: string; storyTitle: string; storyStatus: StoryStatus; isFirst: boolean; status: RevisionStatus; isCurrent: boolean;
      hiddenAt: Date | null; editSummary: string | null; flags: string[]; createdAt: Date }[]
  >`
    SELECT r.id, r.story_id, COALESCE(cur.title, r.title) AS story_title, s.status AS story_status, r.parent_revision_id IS NULL AS is_first,
           r.status, COALESCE(s.current_revision_id = r.id, false) AS is_current, r.hidden_at, r.edit_summary, r.flags, r.created_at
    FROM story_revisions r
    JOIN stories s ON s.id = r.story_id
    LEFT JOIN story_revisions cur ON cur.id = s.current_revision_id
    WHERE r.author_id = ${userId}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const items = rows.slice(0, limit).map(({ hiddenAt, createdAt, ...r }) => ({
    ...r,
    removed: !!hiddenAt,
    createdAt: createdAt.toISOString(),
  }));
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}
