import {
  LIMITS,
  TRUST,
  baseCellCount,
  compactDisplay,
  toBaseCells,
  type Category,
  type CollectionDetail,
  type CollectionKind,
  type CollectionSummary,
} from '@hexstory/shared';
import type { z } from 'zod';
import type { collectionSchema } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { POLICY, canReview } from '../policy.js';
import { logModAction } from './modlog.js';
import { closeReportsAbout, collectionRuleSql, loKeySql, summaryColumns, toSummary, type StoryDeps, type SummaryRow } from './stories.js';

type CollectionData = z.output<typeof collectionSchema>;

interface CollectionRow {
  id: string;
  title: string;
  description: string;
  kind: CollectionKind;
  cells: string[];
  categories: Category[];
  fromYear: number | null;
  toYear: number | null;
  status: 'active' | 'hidden';
  featuredAt: Date | null;
  createdBy: string;
  creatorName: string;
  updatedAt: Date;
  storyCount: number;
}

/** Published stories in a collection: hand-picked ones plus those its rules match. `c` must be in scope. */
const storyCountSql = (sql: Db) => sql`(
  SELECT count(*)::int FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
  WHERE s.status = 'active'
    AND (EXISTS (SELECT 1 FROM collection_items i WHERE i.collection_id = c.id AND i.story_id = s.id) OR ${collectionRuleSql(sql)}))`;

const collectionColumns = (sql: Db) => sql`
  c.id, c.title, c.description, c.kind, c.cells, c.categories, c.from_year, c.to_year, c.status, c.featured_at,
  c.created_by, u.display_name AS creator_name, c.updated_at, ${storyCountSql(sql)} AS story_count`;

function toCollectionSummary(r: CollectionRow): CollectionSummary {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    description: r.description,
    storyCount: r.storyCount,
    featured: !!r.featuredAt,
    cells: r.cells,
    createdBy: { id: r.createdBy, displayName: r.creatorName },
    updatedAt: r.updatedAt.toISOString(),
  };
}

const canEdit = (c: { createdBy: string }, viewer: SessionUser | null) =>
  !!viewer && !viewer.bannedAt && (viewer.id === c.createdBy || canReview(viewer.trustLevel));

/** Active collections: featured first, then recently updated. Reviewers can include hidden ones. */
export async function listCollections(
  sql: Sql,
  query: { kind?: CollectionKind; offset: number },
  limit = 30,
): Promise<{ items: CollectionSummary[]; nextOffset: number | null }> {
  const rows = await sql<CollectionRow[]>`
    SELECT ${collectionColumns(sql)}
    FROM collections c JOIN users u ON u.id = c.created_by
    WHERE c.status = 'active' ${query.kind ? sql`AND c.kind = ${query.kind}` : sql``}
    ORDER BY c.featured_at DESC NULLS LAST, c.updated_at DESC, c.id
    LIMIT ${limit + 1} OFFSET ${query.offset}`;
  return { items: rows.slice(0, limit).map(toCollectionSummary), nextOffset: rows.length > limit ? query.offset + limit : null };
}

/** How many rule-matched stories a collection page shows (hand-picked ones are capped by LIMITS). */
const MATCHED_MAX = 200;

export async function getCollection({ sql, storage }: StoryDeps, id: string, viewer: SessionUser | null): Promise<CollectionDetail> {
  const [c] = await sql<CollectionRow[]>`
    SELECT ${collectionColumns(sql)} FROM collections c JOIN users u ON u.id = c.created_by WHERE c.id = ${id}`;
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  if (!c || (c.status === 'hidden' && !reviewer)) throw notFound('Collection');

  const items = await sql<(SummaryRow & { note: string | null })[]>`
    SELECT ${summaryColumns(sql)}, i.note
    FROM collection_items i
    JOIN stories s ON s.id = i.story_id
    JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE i.collection_id = ${id} AND s.status = 'active'
    ORDER BY i.position`;
  // Rule matches are read chronologically, oldest first, like a narrative.
  const matched = await sql<(SummaryRow & { total: number })[]>`
    SELECT ${summaryColumns(sql)}, count(*) OVER ()::int AS total
    FROM collections c, stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE c.id = ${id} AND s.status = 'active' AND ${collectionRuleSql(sql)}
      AND NOT EXISTS (SELECT 1 FROM collection_items i WHERE i.collection_id = c.id AND i.story_id = s.id)
    ORDER BY ${loKeySql(sql)}, s.id
    LIMIT ${MATCHED_MAX}`;
  return {
    ...toCollectionSummary(c),
    status: c.status,
    categories: c.categories,
    fromYear: c.fromYear,
    toYear: c.toYear,
    items: items.map((r) => ({ story: toSummary(storage, r), note: r.note })),
    matched: matched.map((r) => toSummary(storage, r)),
    matchedTotal: matched[0]?.total ?? 0,
    can: { edit: canEdit(c, viewer) && c.status === 'active', hide: reviewer, feature: reviewer && c.status === 'active' },
  };
}

async function prepare(tx: Db, input: CollectionData) {
  // Count before expanding, as for stories.
  if (baseCellCount(input.cells) > LIMITS.collectionCellsMax) throw badRequest('That area is too large. Pick a smaller one.', 'area-too-large');
  const cells = input.cells.length ? compactDisplay(toBaseCells([...new Set(input.cells)])).sort() : [];
  if (input.items.length) {
    const found = await tx<{ id: string }[]>`SELECT id FROM stories WHERE id IN ${tx(input.items.map((i) => i.storyId))} AND status = 'active'`;
    if (found.length !== input.items.length) throw badRequest('Only published stories can be added to a collection.', 'bad-item');
  }
  return {
    title: input.title,
    description: input.description,
    kind: input.kind,
    cells,
    categories: input.categories,
    from_year: input.fromYear ?? null,
    to_year: input.toYear ?? null,
  };
}

async function writeItems(tx: Db, id: string, items: CollectionData['items']) {
  await tx`DELETE FROM collection_items WHERE collection_id = ${id}`;
  if (!items.length) return;
  await tx`INSERT INTO collection_items ${tx(items.map((item, position) => ({ collection_id: id, story_id: item.storyId, position, note: item.note ?? null })))}`;
}

/** Members and above can start collections (a few a day); Newcomers can't yet. */
export async function createCollection(sql: Sql, user: SessionUser, input: CollectionData): Promise<{ id: string }> {
  if (user.trustLevel < TRUST.MEMBER) throw forbidden('Collections can be started once you are a Member.');
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
    const [recent] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM collections WHERE created_by = ${user.id} AND created_at > now() - interval '1 day'`;
    const limit = POLICY.collectionsPerDay[user.trustLevel];
    if ((recent?.n ?? 0) >= limit) throw tooMany(`You've reached today's limit of ${limit} new collections.`);
    const fields = await prepare(tx, input);
    const [row] = await tx<{ id: string }[]>`INSERT INTO collections ${tx({ ...fields, created_by: user.id })} RETURNING id`;
    await writeItems(tx, row!.id, input.items);
    return { id: row!.id };
  });
}

/** Its creator and reviewers can change a collection. */
export async function updateCollection(sql: Sql, user: SessionUser, id: string, input: CollectionData): Promise<void> {
  await sql.begin(async (tx) => {
    const [c] = await tx<{ createdBy: string; status: string }[]>`SELECT created_by, status FROM collections WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('Collection');
    if (!canEdit(c, user)) throw forbidden('Only its creator and reviewers can change this collection.');
    if (c.status !== 'active') throw conflict('This collection is hidden.');
    const fields = await prepare(tx, input);
    await tx`UPDATE collections SET ${tx(fields)}, updated_at = now() WHERE id = ${id}`;
    await writeItems(tx, id, input.items);
    if (user.id !== c.createdBy) await logModAction(tx, user.id, 'edit-collection', 'collection', id, null);
  });
}

/** Reviewers hide a collection; only moderators bring one back. */
export async function setCollectionStatus(sql: Sql, user: SessionUser, id: string, status: 'active' | 'hidden', reason: string | null) {
  if (!canReview(user.trustLevel)) throw forbidden();
  if (status === 'active' && user.trustLevel < TRUST.MODERATOR) throw forbidden('Only moderators can bring back a hidden collection.');
  await sql.begin(async (tx) => {
    const [row] = await tx`UPDATE collections SET status = ${status}, updated_at = now() WHERE id = ${id} AND status <> ${status} RETURNING id`;
    if (!row) throw conflict(status === 'hidden' ? 'This collection is already hidden.' : 'This collection is not hidden.', 'already-decided');
    if (status === 'hidden') await closeReportsAbout(tx, user.id, 'collection', [id]);
    await logModAction(tx, user.id, status === 'hidden' ? 'hide' : 'unhide', 'collection', id, reason);
  });
}

export async function setCollectionFeatured(sql: Sql, user: SessionUser, id: string, featured: boolean) {
  if (!canReview(user.trustLevel)) throw forbidden();
  await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE collections SET featured_at = ${featured ? tx`now()` : null}
      WHERE id = ${id} AND status = 'active' AND (featured_at IS NULL) = ${featured}
      RETURNING id`;
    if (row) await logModAction(tx, user.id, featured ? 'feature' : 'unfeature', 'collection', id, null);
  });
}

/** Collections for the home page: featured ones first, then recently updated ones. */
export async function homeCollections(sql: Sql, limit: number): Promise<CollectionSummary[]> {
  return (await listCollections(sql, { offset: 0 }, limit)).items;
}
