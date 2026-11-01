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
  type CreateStoryInput,
  type EditStoryInput,
  type RevisionListItem,
  type RevisionStatus,
  type RichDoc,
  type StoryDetail,
  type StoryRevision,
  type StoryStatus,
  type StorySummary,
  type TrustLevel,
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
  createdAt: Date;
}

interface StoryRow {
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
    createdAt: r.createdAt.toISOString(),
  };
}

/** `where` is a fragment placed after WHERE; it may also carry ORDER BY / LIMIT. */
async function fetchRevisions(sql: Db, where: ReturnType<Db>): Promise<RevisionRow[]> {
  return sql<RevisionRow[]>`
    SELECT r.id, r.story_id, r.parent_revision_id, r.author_id, u.display_name AS author_name,
           r.title, r.body, r.content, r.image_key, r.image_credit, r.cells,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day,
           r.is_ongoing, r.is_approx, r.sources, r.status, r.edit_summary, r.flags, r.created_at
    FROM story_revisions r JOIN users u ON u.id = r.author_id
    WHERE ${where}`;
}

async function fetchRevision(sql: Db, id: string): Promise<RevisionRow | undefined> {
  const [row] = await fetchRevisions(sql, sql`r.id = ${id}`);
  return row;
}

async function fetchStory(sql: Db, id: string, lock = false): Promise<StoryRow | undefined> {
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
    WHERE c.res = ${res} AND s.status <> 'hidden'
    GROUP BY c.cell`;
  countCache.set(res, { at: Date.now(), data: [...data] });
  return data;
}

// ---------------------------------------------------------------------------------------------
// Reading

export async function listStoriesInCell(
  { sql, storage }: StoryDeps,
  cell: string,
  offset: number,
  limit = 30,
): Promise<{ items: StorySummary[]; nextOffset: number | null }> {
  const rows = await sql<(RevisionRow & { storyStatus: StoryStatus; cellCount: number; sourceCount: number })[]>`
    SELECT s.id, s.status AS story_status, s.cell_count, r.title, r.image_key, r.source_count,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day,
           r.is_ongoing, r.is_approx
    FROM story_cells c
    JOIN stories s ON s.id = c.story_id
    JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE c.cell = ${cell} AND s.status <> 'hidden'
    ORDER BY r.is_ongoing DESC, r.sort_key DESC, s.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    thumbUrl: imageUrls(storage, r.imageKey).thumbUrl,
    ...datesOf(r),
    isOngoing: r.isOngoing,
    isApprox: r.isApprox,
    sourceCount: r.sourceCount,
    cellCount: r.cellCount,
    status: r.storyStatus,
  }));
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}

function permissions(story: StoryRow, viewer: SessionUser | null): StoryDetail['can'] {
  if (!viewer || viewer.bannedAt) return { edit: false, editGoesLive: false, review: false };
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

function assertVisible(story: StoryRow | undefined, viewer: SessionUser | null): asserts story is StoryRow {
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  if (!story || (!reviewer && (story.status === 'hidden' || !story.currentRevisionId))) throw notFound('Story');
}

export async function getStory({ sql, storage }: StoryDeps, id: string, viewer: SessionUser | null): Promise<StoryDetail> {
  const story = await fetchStory(sql, id);
  assertVisible(story, viewer);

  // A story whose first revision is still pending has no current revision; reviewers see the pending one.
  const [revision] = story.currentRevisionId
    ? await fetchRevisions(sql, sql`r.id = ${story.currentRevisionId}`)
    : await fetchRevisions(sql, sql`r.story_id = ${id} ORDER BY r.created_at LIMIT 1`);
  if (!revision) throw notFound('Story');
  const [counts] = await sql<{ pending: number }[]>`
    SELECT count(*)::int AS pending FROM story_revisions WHERE story_id = ${id} AND status = 'pending'`;

  return {
    id: story.id,
    status: story.status,
    protectionLevel: story.protectionLevel,
    createdAt: story.createdAt.toISOString(),
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
    { id: string; authorId: string; authorName: string; status: RevisionStatus; editSummary: string | null; flags: string[]; createdAt: Date }[]
  >`
    SELECT r.id, r.author_id, u.display_name AS author_name, r.status, r.edit_summary, r.flags, r.created_at
    FROM story_revisions r JOIN users u ON u.id = r.author_id
    WHERE r.story_id = ${storyId}
    ORDER BY r.created_at DESC
    LIMIT 200`;
  return rows.filter((r) => r.status === 'accepted' || canSeeUnaccepted(viewer, r.authorId)).map((r) => ({
    id: r.id,
    author: { id: r.authorId, displayName: r.authorName },
    status: r.status,
    editSummary: r.editSummary,
    flags: r.flags,
    isCurrent: r.id === story.currentRevisionId,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getRevision({ sql, storage }: StoryDeps, id: string, viewer: SessionUser | null): Promise<StoryRevision> {
  const revision = await fetchRevision(sql, id);
  if (!revision) throw notFound('Version');
  const story = await fetchStory(sql, revision.storyId);
  assertVisible(story, viewer);
  // Versions that never went live (pending or rejected) may contain abuse; only reviewers and the author see them.
  if (revision.status !== 'accepted' && !canSeeUnaccepted(viewer, revision.authorId)) throw notFound('Version');
  return toRevision(storage, revision);
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Points the story at a revision and rebuilds its cell index. */
async function applyRevision(tx: Db, storyId: string, revision: { id: string; cells: string[] }): Promise<void> {
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

export type WriteResult = { storyId: string; revisionId: string; status: 'live' | 'pending' };

export async function createStory({ sql, storage }: StoryDeps, user: SessionUser, input: CreateStoryInput): Promise<WriteResult> {
  const content = await prepareContent(storage, input);
  const flags = detectFlags({ previousBody: null, body: content.body, links: docLinkCount(content.content), trustLevel: user.trustLevel });
  const held = flags.length > 0 && !canReview(user.trustLevel);

  const result = await sql.begin(async (tx) => {
    await assertWithinDailyLimit(tx, user, 'stories');
    const [story] = await tx<{ id: string }[]>`
      INSERT INTO stories (status, created_by)
      VALUES (${user.trustLevel >= TRUST.MEMBER ? 'active' : 'unreviewed'}, ${user.id})
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
    return { storyId, revisionId, status: held ? 'pending' : 'live' } as const;
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
    return { storyId, revisionId, status: live ? 'live' : 'pending' } as const;
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
    }
    await tx`
      UPDATE story_revisions SET status = ${decision === 'accept' ? 'accepted' : 'rejected'},
        reviewed_by = ${user.id}, reviewed_at = now()
      WHERE id = ${revisionId}`;
    await logModAction(tx, user.id, decision, 'revision', revisionId, reason);
    return rev.authorId;
  });
  await refreshTrust(sql, authorId);
}

/** Restoring copies an old version into a new revision, so history stays linear and append-only. */
export async function restoreRevision({ sql }: StoryDeps, user: SessionUser, storyId: string, revisionId: string): Promise<WriteResult> {
  if (!canReview(user.trustLevel)) throw forbidden();
  return sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (user.trustLevel < liveEditThreshold(story.protectionLevel)) throw forbidden('This story is protected.');
    const old = await fetchRevision(tx, revisionId);
    if (!old || old.storyId !== storyId) throw notFound('Version');
    // Only versions that were live once can be restored; pending ones go through review instead.
    if (old.status !== 'accepted') throw badRequest('Only versions that were accepted can be restored.');
    if (old.id === story.currentRevisionId) throw badRequest('That is already the current version.');

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO story_revisions (story_id, parent_revision_id, author_id, title, body, content, image_key, image_credit, cells,
        start_year, start_month, start_day, end_year, end_month, end_day, is_ongoing, is_approx, sources,
        status, edit_summary, reviewed_by, reviewed_at)
      SELECT story_id, ${story.currentRevisionId}, ${user.id}, title, body, content, image_key, image_credit, cells,
        start_year, start_month, start_day, end_year, end_month, end_day, is_ongoing, is_approx, sources,
        'accepted', ${`Restored the version from ${old.createdAt.toISOString().slice(0, 10)}`}, ${user.id}, now()
      FROM story_revisions WHERE id = ${revisionId}
      RETURNING id`;
    await applyRevision(tx, storyId, { id: row!.id, cells: old.cells });
    await logModAction(tx, user.id, 'restore', 'story', storyId, revisionId);
    return { storyId, revisionId: row!.id, status: 'live' } as const;
  });
}

export async function setStoryStatus(sql: Sql, user: SessionUser, storyId: string, status: 'active' | 'hidden', reason: string | null) {
  if (!canReview(user.trustLevel)) throw forbidden();
  await sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (story.status === 'hidden' && user.trustLevel < TRUST.MODERATOR) {
      throw forbidden('Only moderators can bring back a hidden story.');
    }
    await tx`UPDATE stories SET status = ${status}, updated_at = now() WHERE id = ${storyId}`;
    await logModAction(tx, user.id, status === 'hidden' ? 'hide' : 'approve', 'story', storyId, reason);
  });
  invalidateCellCounts();
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
  const pending = await fetchRevisions(sql, sql`r.status = 'pending' ORDER BY r.created_at LIMIT 50`);
  const parentIds = pending.map((r) => r.parentRevisionId).filter((id): id is string => !!id);
  const parents = parentIds.length ? await fetchRevisions(sql, sql`r.id IN ${sql(parentIds)}`) : [];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return pending.map((r) => ({
    revision: toRevision(storage, r),
    currentRevision: r.parentRevisionId && byId.has(r.parentRevisionId) ? toRevision(storage, byId.get(r.parentRevisionId)!) : null,
  }));
}

export async function unreviewedStories({ sql, storage }: StoryDeps): Promise<StorySummary[]> {
  const rows = await sql<(RevisionRow & { storyStatus: StoryStatus; cellCount: number; sourceCount: number; storyId: string })[]>`
    SELECT s.id AS story_id, s.status AS story_status, s.cell_count, r.title, r.image_key, r.source_count,
           r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day, r.is_ongoing, r.is_approx
    FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE s.status = 'unreviewed'
    ORDER BY s.created_at
    LIMIT 50`;
  return rows.map((r) => ({
    id: r.storyId,
    title: r.title,
    thumbUrl: imageUrls(storage, r.imageKey).thumbUrl,
    ...datesOf(r),
    isOngoing: r.isOngoing,
    isApprox: r.isApprox,
    sourceCount: r.sourceCount,
    cellCount: r.cellCount,
    status: r.storyStatus,
  }));
}
