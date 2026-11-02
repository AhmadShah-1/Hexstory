import {
  BASE_RES,
  DEVELOPING_DAYS,
  HISTORICAL_GAP_DAYS,
  INVERSE_RELATION,
  LIMITS,
  TRUST,
  baseCellCount,
  cellAt,
  cellsCenter,
  compact,
  docImageKeys,
  docLinkCount,
  docToPlainText,
  eventRange,
  indexCells,
  legacyDoc,
  toBaseCells,
  uncompact,
  yearRangeKeys,
  type Category,
  type CollectionRef,
  type ContributionEdit,
  type ContributionStory,
  type EditStoryData,
  type LinkRelation,
  type MapPoint,
  type Page,
  type RevisionListItem,
  type RevisionStatus,
  type RichDoc,
  type StoryConnection,
  type StoryDetail,
  type StoryInput,
  type StoryListQuery,
  type StoryRef,
  type StoryRevision,
  type StoryStatus,
  type StorySummary,
  type TrustLevel,
  type UnreviewedStory,
  type WriteResult,
} from '@hexstory/shared';
import type { z } from 'zod';
import type { storyListQuerySchema } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../errors.js';
import { POLICY, canReview, detectFlags, liveEditThreshold } from '../policy.js';
import { imageFileNames, type Storage } from '../storage/index.js';
import { listDevelopments } from './developments.js';
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
  summary: string | null;
  categories: Category[];
  lat: number | null;
  lng: number | null;
  placeName: string | null;
  people: string[];
  links: { storyId: string; relation: LinkRelation }[];
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
  /** When the story first became public, and the version public at that moment (null: never published). */
  publishedAt: Date | null;
  publishedRevisionId: string | null;
  lastUpdateAt: Date;
  featuredAt: Date | null;
  /** Set for stories loaded by the importer (docs/IMPORT.md). */
  importKey: string | null;
  importBatch: string | null;
}

/**
 * Internal options for the importer only; no HTTP route passes them. Imports run as the system
 * archive account, which isn't subject to the per-person daily limits.
 */
export interface SystemWriteOptions {
  skipDailyLimit?: boolean;
  importKey?: string;
  importBatch?: string;
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
    summary: r.summary,
    categories: r.categories,
    location: r.lat === null || r.lng === null ? null : { lat: r.lat, lng: r.lng, placeName: r.placeName },
    cells: r.cells,
    ...datesOf(r),
    isOngoing: r.isOngoing,
    isApprox: r.isApprox,
    sources: r.sources,
    people: r.people,
    links: r.links,
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
           r.summary, r.categories, r.lat, r.lng, r.place_name, r.people, r.links,
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
// SQL building blocks. `s` is a story and `r` its current revision in every fragment below.

/** First moment the event touches, as a comparable key; mirrors eventRange() in packages/shared. */
export const loKeySql = (sql: Db) => sql`(r.start_year * 10000 + COALESCE(r.start_month, 1) * 100 + COALESCE(r.start_day, 1))`;
/** Last moment the event touches; ongoing events never end. */
export const hiKeySql = (sql: Db) => sql`(CASE WHEN r.is_ongoing THEN 2147483647 ELSE
  COALESCE(r.end_year, r.start_year) * 10000
  + COALESCE(CASE WHEN r.end_year IS NULL THEN r.start_month ELSE r.end_month END, 12) * 100
  + COALESCE(CASE WHEN r.end_year IS NULL THEN r.start_day ELSE r.end_day END, 31) END)`;

/** An account of an older event, newly added: its last date is more than a year before publication. */
const historicalSql = (sql: Db) => sql`(NOT r.is_ongoing AND ${hiKeySql(sql)}
  < to_char(COALESCE(s.published_at, s.created_at) - make_interval(days => ${HISTORICAL_GAP_DAYS}), 'YYYYMMDD')::int)`;

/** Ongoing, or had a development recently. */
const developingSql = (sql: Db) => sql`(r.is_ongoing OR EXISTS (
  SELECT 1 FROM story_developments d WHERE d.story_id = s.id AND d.status = 'accepted' AND d.hidden_at IS NULL
    AND d.created_at > now() - make_interval(days => ${DEVELOPING_DAYS})))`;

/**
 * "Historical significance" as the community has recorded it: how many published stories link to this
 * one (as cause, part or consequence), how much its timeline has developed, how well it is sourced, and
 * whether reviewers featured it. It deliberately ignores how many stories a place has.
 */
export const significanceSql = (sql: Db) => sql`(
  3 * (SELECT count(*) FROM story_links l JOIN stories ls ON ls.id = l.from_story_id WHERE l.to_story_id = s.id AND ls.status = 'active')
  + 2 * LEAST(10, (SELECT count(*) FROM story_developments d WHERE d.story_id = s.id AND d.status = 'accepted' AND d.hidden_at IS NULL))
  + LEAST(5, r.source_count)
  + CASE WHEN s.featured_at IS NOT NULL THEN 10 ELSE 0 END)`;

/** Columns for a StorySummary (toSummary). */
export const summaryColumns = (sql: Db) => sql`
  s.id AS story_id, s.status AS story_status, s.cell_count, s.published_at, s.last_update_at, s.featured_at,
  r.title, COALESCE(r.summary, left(r.body, 240)) AS summary, r.image_key, r.source_count, r.categories, r.place_name,
  r.start_year, r.start_month, r.start_day, r.end_year, r.end_month, r.end_day, r.is_ongoing, r.is_approx,
  ${developingSql(sql)} AS developing, ${historicalSql(sql)} AS is_historical`;

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

// ---------------------------------------------------------------------------------------------
// The map: every published story as a point, cached briefly per instance (and by the CDN).

const MAP_TTL_MS = 30_000;
let mapCache: { at: number; data: MapPoint[] } | null = null;

export function invalidateMapCache(): void {
  mapCache = null;
}

/**
 * The map draws, filters (by time and category) and counts stories in the browser from this one list,
 * so moving the timeline slider or switching layers costs no requests. A few thousand stories are a
 * few hundred KB gzipped; beyond MAP_POINTS_MAX the oldest-updated drop out (see DESIGN.md follow-ups).
 */
export const MAP_POINTS_MAX = 20_000;

export async function mapPoints(sql: Sql): Promise<MapPoint[]> {
  if (mapCache && Date.now() - mapCache.at < MAP_TTL_MS) return mapCache.data;
  const rows = await sql<{ id: string; title: string; lat: number | null; lng: number | null; cells: string[]; categories: Category[];
    startYear: number; startMonth: number | null; startDay: number | null; endYear: number | null; endMonth: number | null; endDay: number | null;
    isOngoing: boolean; developing: boolean }[]>`
    SELECT s.id, r.title, r.lat, r.lng, r.cells, r.categories, r.start_year, r.start_month, r.start_day,
           r.end_year, r.end_month, r.end_day, r.is_ongoing, ${developingSql(sql)} AS developing
    FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE s.status = 'active'
    ORDER BY s.last_update_at DESC
    LIMIT ${MAP_POINTS_MAX}`;
  const data: MapPoint[] = [];
  for (const r of rows) {
    const point = r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : cellsCenter(r.cells);
    if (!point) continue;
    const { start, end } = datesOf(r);
    const { lo, hi } = eventRange({ start, end, isOngoing: r.isOngoing });
    data.push({ id: r.id, title: r.title, lat: point.lat, lng: point.lng, categories: r.categories, lo, hi, year: r.startYear, developing: r.developing });
  }
  mapCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------------------------
// Lists: one query for every list (explore, a region, a person, search), with filters and orderings.

export type StoryListFilters = z.output<typeof storyListQuerySchema>;

/**
 * Published stories matching the filters. In a region (`cell`) the ones waiting for approval that this
 * viewer may see are included too (their own, or all for reviewers), so a newcomer finds the story
 * they just wrote where they put it.
 */
export async function listStories(
  { sql, storage }: StoryDeps,
  f: StoryListFilters,
  viewer: SessionUser | null,
  limit: number = LIMITS.pageSize,
): Promise<Page<StorySummary>> {
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  const range = f.from != null || f.to != null ? yearRangeKeys(f.from, f.to) : null;
  const q = f.q?.trim() || null;
  const sort = f.sort === 'relevance' && !q && !f.cell ? 'significance' : f.sort;
  const order =
    sort === 'published' ? sql`COALESCE(s.published_at, s.created_at) DESC`
    : sort === 'updated' ? sql`s.last_update_at DESC`
    : sort === 'significance' ? sql`${significanceSql(sql)} DESC, ${hiKeySql(sql)} DESC`
    : sort === 'relevance' && q ? sql`(CASE WHEN r.title ILIKE ${`${q.replace(/[\\%_]/g, '\\$&')}%`} THEN 3 WHEN r.title ILIKE ${likePattern(q)} THEN 2 ELSE 1 END) DESC, ${significanceSql(sql)} DESC`
    // In a region, stories about that place specifically (a point or a small area) come before wide ones.
    : sort === 'relevance' ? sql`s.cell_count ASC, ${significanceSql(sql)} DESC`
    : sql`${hiKeySql(sql)} DESC, ${loKeySql(sql)} DESC`;
  const rows = await sql<SummaryRow[]>`
    SELECT ${summaryColumns(sql)}
    FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE (s.status = 'active'
        ${f.cell ? sql`OR (s.status = 'unreviewed' AND (${reviewer} OR s.created_by = ${viewer?.id ?? null}))` : sql``})
      ${f.cell ? sql`AND EXISTS (SELECT 1 FROM story_cells c WHERE c.story_id = s.id AND c.cell = ${f.cell})` : sql``}
      ${f.categories.length ? sql`AND r.categories && ${f.categories}::text[]` : sql``}
      ${range ? sql`AND ${loKeySql(sql)} <= ${range.hi} AND ${hiKeySql(sql)} >= ${range.lo}` : sql``}
      ${f.kind === 'historical' ? sql`AND ${historicalSql(sql)}` : f.kind === 'new' ? sql`AND NOT ${historicalSql(sql)}` : sql``}
      ${f.ongoing ? sql`AND ${developingSql(sql)}` : sql``}
      ${f.on ? sql`AND ((r.start_month = ${f.on[0]} AND r.start_day = ${f.on[1]}) OR (r.end_month = ${f.on[0]} AND r.end_day = ${f.on[1]}))` : sql``}
      ${q ? sql`AND (r.title ILIKE ${likePattern(q)} OR r.summary ILIKE ${likePattern(q)} OR r.place_name ILIKE ${likePattern(q)}
                    OR EXISTS (SELECT 1 FROM unnest(r.people) p WHERE p ILIKE ${likePattern(q)}))` : sql``}
      ${f.person ? sql`AND EXISTS (SELECT 1 FROM unnest(r.people) p WHERE lower(p) = lower(${f.person}))` : sql``}
    ORDER BY ${order}, s.id DESC
    LIMIT ${limit + 1} OFFSET ${f.offset}`;
  return { items: rows.slice(0, limit).map((r) => toSummary(storage, r)), nextOffset: rows.length > limit ? f.offset + limit : null };
}

/** Published stories by id, in the order asked (unknown or unpublished ids are skipped). */
export async function storySummaries({ sql, storage }: StoryDeps, ids: string[]): Promise<StorySummary[]> {
  if (!ids.length) return [];
  const rows = await sql<SummaryRow[]>`
    SELECT ${summaryColumns(sql)}
    FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE s.id IN ${sql(ids)} AND s.status = 'active'`;
  const byId = new Map(rows.map((r) => [r.storyId, toSummary(storage, r)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** A random published story; `surprise` prefers well-sourced or connected ones. Null when there are none. */
export async function randomStory(sql: Sql, mode: 'surprise' | 'any'): Promise<string | null> {
  const pick = async (where: ReturnType<Db>) => {
    const [row] = await sql<{ id: string }[]>`
      SELECT s.id FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
      WHERE s.status = 'active' AND ${where}
      ORDER BY random() LIMIT 1`;
    return row?.id ?? null;
  };
  if (mode === 'surprise') {
    const id = await pick(sql`(s.featured_at IS NOT NULL OR r.source_count >= ${POLICY.surpriseMinSources}
      OR EXISTS (SELECT 1 FROM story_links l WHERE l.to_story_id = s.id OR l.from_story_id = s.id))`);
    if (id) return id;
  }
  return pick(sql`true`);
}

export function permissions(story: StoryRow, viewer: SessionUser | null): StoryDetail['can'] {
  const none = { edit: false, editGoesLive: false, review: false, addDevelopment: false, correct: false, feature: false };
  if (!viewer || viewer.bannedAt || !viewer.termsAcceptedAt) return none;
  const review = canReview(viewer.trustLevel);
  // A story whose first version is still held can't be edited until that version is reviewed.
  if (!story.currentRevisionId) return { ...none, review };
  const isCreatorOfUnreviewed =
    viewer.id === story.createdBy && story.status === 'unreviewed' && story.protectionLevel === TRUST.NEW;
  return {
    edit: story.status !== 'hidden' || review,
    editGoesLive: viewer.trustLevel >= liveEditThreshold(story.protectionLevel) || isCreatorOfUnreviewed,
    review,
    addDevelopment: story.status !== 'hidden',
    correct: story.status === 'active',
    feature: review && story.status === 'active',
  };
}

export const canSeeUnaccepted = (viewer: SessionUser | null, authorId: string) =>
  !!viewer && (canReview(viewer.trustLevel) || viewer.id === authorId);

/**
 * Published stories are public. A story waiting for approval (or whose first version is held) is
 * visible only to the person who started it and to reviewers; hidden stories only to reviewers.
 */
export function canSeeStory(story: StoryRow, viewer: SessionUser | null): boolean {
  if (viewer && canReview(viewer.trustLevel)) return true;
  if (story.status === 'hidden') return false;
  if (story.status === 'active' && story.currentRevisionId) return true;
  return !!viewer && viewer.id === story.createdBy;
}

export function assertVisible(story: StoryRow | undefined, viewer: SessionUser | null): asserts story is StoryRow {
  if (!story || !canSeeStory(story, viewer)) throw notFound('Story');
}

/**
 * Who may see a version. Removed versions: reviewers only. Otherwise the author and reviewers always;
 * everyone else only accepted versions from the story's publication on (the approved version and
 * later ones), so a newcomer's earlier drafts, which no reviewer read, never become public.
 */
function canSeeRevision(
  r: { id: string; status: RevisionStatus; authorId: string; hiddenAt: Date | null; createdAt: Date },
  story: StoryRow,
  viewer: SessionUser | null,
): boolean {
  if (viewer && canReview(viewer.trustLevel)) return true;
  if (r.hiddenAt) return false;
  if (canSeeUnaccepted(viewer, r.authorId)) return true;
  return r.status === 'accepted' && !!story.publishedAt && (r.id === story.publishedRevisionId || r.createdAt > story.publishedAt);
}

/** Marks a story as published (once: later approvals keep the first date and version). */
async function markPublished(tx: Db, storyId: string, revisionId: string): Promise<void> {
  await tx`
    UPDATE stories SET published_at = COALESCE(published_at, now()), published_revision_id = COALESCE(published_revision_id, ${revisionId})
    WHERE id = ${storyId}`;
}

export async function getStory(deps: StoryDeps, id: string, viewer: SessionUser | null): Promise<StoryDetail> {
  const { sql, storage } = deps;
  const story = await fetchStory(sql, id);
  assertVisible(story, viewer);

  // A story whose first revision is still pending (or was rejected) has no current revision; its
  // author and reviewers see that first one.
  const [revision] = story.currentRevisionId
    ? await fetchRevisions(sql, sql`r.id = ${story.currentRevisionId}`)
    : await fetchRevisions(sql, sql`r.story_id = ${id} ORDER BY r.created_at LIMIT 1`);
  if (!revision || (!story.currentRevisionId && !canSeeRevision(revision, story, viewer))) throw notFound('Story');
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  const [counts] = await sql<{ pending: number; creatorName: string; openCorrections: number; developmentCount: number }[]>`
    SELECT (SELECT count(*)::int FROM story_revisions WHERE story_id = ${id} AND status = 'pending') AS pending,
           (SELECT display_name FROM users WHERE id = ${story.createdBy}) AS creator_name,
           (SELECT count(*)::int FROM corrections WHERE story_id = ${id} AND status = 'open' AND hidden_at IS NULL) AS open_corrections,
           (SELECT count(*)::int FROM story_developments WHERE story_id = ${id} AND status = 'accepted' AND hidden_at IS NULL) AS development_count`;
  const developments = await listDevelopments(deps, id, viewer, 0, 5);
  const point = revision.lat !== null && revision.lng !== null ? { lat: revision.lat, lng: revision.lng } : cellsCenter(revision.cells) ?? { lat: 0, lng: 0 };
  const { end } = datesOf(revision);
  const lastDate = end ?? { year: revision.startYear, month: revision.startMonth, day: revision.startDay };
  const published = story.publishedAt ?? story.createdAt;
  const gapDays = (published.getTime() - Date.UTC(lastDate.year, (lastDate.month ?? 12) - 1, lastDate.day ?? 28)) / 86_400_000;

  return {
    id: story.id,
    status: story.status,
    protectionLevel: story.protectionLevel,
    createdAt: story.createdAt.toISOString(),
    createdBy: { id: story.createdBy, displayName: counts?.creatorName ?? '' },
    revision: toRevision(storage, revision),
    cellCount: story.cellCount,
    pendingCount: counts?.pending ?? 0,
    point,
    publishedAt: story.publishedAt?.toISOString() ?? null,
    lastUpdateAt: story.lastUpdateAt.toISOString(),
    featured: !!story.featuredAt,
    // Only while the imported text stands: once someone else edits it, it is no longer what was imported.
    imported: !!story.importBatch && revision.authorId === story.createdBy,
    isHistorical: !revision.isOngoing && gapDays > HISTORICAL_GAP_DAYS,
    connections: await connectionsOf(deps, id, revision.links, viewer),
    developments: developments.items,
    developmentCount: counts?.developmentCount ?? 0,
    openCorrections: counts?.openCorrections ?? 0,
    collections: await collectionsContaining(sql, id, reviewer),
    can: permissions(story, viewer),
  };
}

/**
 * Both directions of a story's links, from its own point of view: the links its current version names,
 * then links other stories name to it (shown with the inverse relation), skipping duplicates and stories
 * the viewer can't see.
 */
async function connectionsOf(
  { sql, storage }: StoryDeps,
  storyId: string,
  outgoing: { storyId: string; relation: LinkRelation }[],
  viewer: SessionUser | null,
): Promise<StoryConnection[]> {
  const incoming = await sql<{ fromStoryId: string; relation: LinkRelation }[]>`
    SELECT from_story_id, relation FROM story_links WHERE to_story_id = ${storyId} LIMIT 100`;
  const wanted: { id: string; relation: LinkRelation; direction: 'out' | 'in' }[] = [];
  const seen = new Set<string>([storyId]);
  for (const l of outgoing) if (!seen.has(l.storyId)) { seen.add(l.storyId); wanted.push({ id: l.storyId, relation: l.relation, direction: 'out' }); }
  for (const l of incoming) if (!seen.has(l.fromStoryId)) { seen.add(l.fromStoryId); wanted.push({ id: l.fromStoryId, relation: INVERSE_RELATION[l.relation], direction: 'in' }); }
  if (!wanted.length) return [];
  const reviewer = !!viewer && canReview(viewer.trustLevel);
  const rows = await sql<(RefRow & { status: StoryStatus; createdBy: string })[]>`
    SELECT s.id, s.status, s.created_by, r.title, r.image_key, r.start_year, r.start_month, r.start_day,
           r.end_year, r.end_month, r.end_day, r.is_ongoing, r.is_approx
    FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE s.id IN ${sql(wanted.map((w) => w.id))}`;
  const visible = new Map(
    rows.filter((r) => r.status === 'active' || reviewer || (r.status === 'unreviewed' && r.createdBy === viewer?.id)).map((r) => [r.id, r]),
  );
  return wanted.flatMap((w) => {
    const row = visible.get(w.id);
    return row ? [{ relation: w.relation, direction: w.direction, story: toRef(storage, row) }] : [];
  });
}

type RefRow = Pick<RevisionRow, 'title' | 'imageKey' | 'startYear' | 'startMonth' | 'startDay' | 'endYear' | 'endMonth' | 'endDay' | 'isOngoing' | 'isApprox'> & { id: string };

function toRef(storage: Storage, r: RefRow): StoryRef {
  return { id: r.id, title: r.title, ...datesOf(r), isOngoing: r.isOngoing, isApprox: r.isApprox, thumbUrl: imageUrls(storage, r.imageKey).thumbUrl };
}

/**
 * Whether story `s` (current revision `r`) belongs to collection `c` by the collection's rules:
 * inside its area, in one of its categories, overlapping its years. A collection without rules
 * matches nothing (it only has hand-picked stories).
 */
export const collectionRuleSql = (sql: Db) => sql`(
  (c.cells <> '{}' OR c.categories <> '{}' OR c.from_year IS NOT NULL OR c.to_year IS NOT NULL)
  AND (c.cells = '{}' OR EXISTS (SELECT 1 FROM story_cells sc WHERE sc.story_id = s.id AND sc.cell = ANY(c.cells)))
  AND (c.categories = '{}' OR r.categories && c.categories)
  AND (c.from_year IS NULL OR ${hiKeySql(sql)} >= c.from_year::bigint * 10000 + 101)
  AND (c.to_year IS NULL OR ${loKeySql(sql)} <= c.to_year::bigint * 10000 + 1231))`;

async function collectionsContaining(sql: Sql, storyId: string, reviewer: boolean): Promise<CollectionRef[]> {
  return sql<CollectionRef[]>`
    SELECT c.id, c.title, c.kind
    FROM collections c, stories s JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE s.id = ${storyId} AND (c.status = 'active' OR ${reviewer})
      AND (EXISTS (SELECT 1 FROM collection_items i WHERE i.collection_id = c.id AND i.story_id = s.id) OR ${collectionRuleSql(sql)})
    ORDER BY c.featured_at DESC NULLS LAST, c.title
    LIMIT 20`;
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
  return rows.filter((r) => canSeeRevision(r, story, viewer)).map((r) => ({
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
  if (!canSeeRevision(revision, story, viewer)) throw notFound('Version');
  return toRevision(storage, revision);
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Points the story at a revision and rebuilds its cell and link indexes. */
export async function applyRevision(tx: Db, storyId: string, revision: { id: string }): Promise<void> {
  const [rev] = await tx<{ cells: string[]; links: { storyId: string; relation: LinkRelation }[] }[]>`
    SELECT cells, links FROM story_revisions WHERE id = ${revision.id}`;
  if (!rev) throw notFound('Version');
  const baseCells = uncompact(rev.cells);
  const rows = indexCells(baseCells).map(({ res, cell }) => ({ storyId, res, cell }));
  await tx`
    UPDATE stories SET current_revision_id = ${revision.id}, cell_count = ${baseCells.length}, updated_at = now(), last_update_at = now()
    WHERE id = ${storyId}`;
  await tx`DELETE FROM story_cells WHERE story_id = ${storyId}`;
  for (let i = 0; i < rows.length; i += 5_000) {
    const chunk = rows.slice(i, i + 5_000).map((r) => [r.storyId, r.res, r.cell]);
    await tx`INSERT INTO story_cells (story_id, res, cell) VALUES ${tx(chunk)}`;
  }
  await tx`DELETE FROM story_links WHERE from_story_id = ${storyId}`;
  const links = rev.links.filter((l) => l.storyId !== storyId);
  if (links.length) {
    await tx`
      INSERT INTO story_links (from_story_id, to_story_id, relation)
      SELECT ${storyId}, s.id, l.relation
      FROM jsonb_to_recordset(${tx.json(links)}) AS l("storyId" uuid, relation text) JOIN stories s ON s.id = l."storyId"
      ON CONFLICT DO NOTHING`;
  }
  invalidateMapCache();
}

async function prepareContent({ sql, storage }: StoryDeps, user: SessionUser, input: StoryInput, storyId: string | null) {
  // Count before expanding: a few thousand coarse cells would otherwise expand to millions.
  if (baseCellCount(input.cells) > LIMITS.cellsMax) {
    throw badRequest('That area is too large. Select fewer or smaller regions.', 'area-too-large');
  }
  // Without a wider area, the story is indexed at the hexagon its point falls in.
  const baseCells = input.cells.length
    ? toBaseCells([...new Set(input.cells)])
    : [cellAt(input.location.lat, input.location.lng, BASE_RES)];
  for (const key of new Set(docImageKeys(input.content))) {
    if (!(await storage.exists(imageFileNames(key).full))) {
      throw badRequest('One of the images was not found. Please upload it again.');
    }
  }
  if (input.links.some((l) => l.storyId === storyId)) throw badRequest("A story can't be connected to itself.", 'bad-link');
  if (input.links.length) {
    // Connections may point at published stories, or at your own (e.g. one waiting for approval).
    const found = await sql<{ id: string }[]>`
      SELECT id FROM stories WHERE id IN ${sql(input.links.map((l) => l.storyId))}
        AND (status = 'active' OR (status = 'unreviewed' AND created_by = ${user.id}))`;
    if (found.length !== input.links.length) throw badRequest('One of the connected stories was not found.', 'bad-link');
  }
  const firstImage = input.content.find((b) => b.type === 'image');
  return {
    title: input.title,
    summary: input.summary,
    body: docToPlainText(input.content),
    content: input.content,
    // The first image doubles as the story's thumbnail in lists.
    image_key: firstImage?.key ?? null,
    image_credit: firstImage?.caption ?? null,
    categories: input.categories,
    lat: input.location.lat,
    lng: input.location.lng,
    place_name: input.location.placeName ?? null,
    people: input.people,
    links: input.links.map((l) => ({ storyId: l.storyId, relation: l.relation })),
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
  fields: Content & { story_id: string; parent_revision_id: string | null; author_id: string; status: RevisionStatus; edit_summary: string | null; flags: string[]; origin: 'create' | 'edit' },
): Promise<string> {
  // jsonb columns go through tx.json so arrays aren't sent as Postgres arrays.
  const values = { ...fields, sources: tx.json(fields.sources), links: tx.json(fields.links) };
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO story_revisions ${tx(values as unknown as Record<string, unknown>)}
    RETURNING id`;
  return row!.id;
}

/**
 * Must run inside the transaction that inserts. The per-user advisory lock serialises concurrent
 * writes from one user so parallel requests can't all pass the count.
 */
export async function assertWithinDailyLimit(sql: Db, user: SessionUser, kind: 'stories' | 'edits'): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
  const limit = kind === 'stories' ? POLICY.storiesPerDay[user.trustLevel] : POLICY.editsPerDay[user.trustLevel];
  const [row] =
    kind === 'stories'
      ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM stories WHERE created_by = ${user.id} AND created_at > now() - interval '1 day'`
      // Only edits: a story's first version counts as a new story, and restore/rollback copies aren't edits.
      // Timeline developments count as edits.
      : await sql<{ n: number }[]>`
          SELECT (SELECT count(*)::int FROM story_revisions WHERE author_id = ${user.id} AND origin = 'edit' AND created_at > now() - interval '1 day')
               + (SELECT count(*)::int FROM story_developments WHERE author_id = ${user.id} AND created_at > now() - interval '1 day') AS n`;
  if ((row?.n ?? 0) >= limit) {
    throw tooMany(`You've reached today's limit of ${limit} ${kind === 'stories' ? 'new stories' : 'edits'}. It grows as you contribute.`);
  }
}

export async function createStory(deps: StoryDeps, user: SessionUser, input: StoryInput, opts: SystemWriteOptions = {}): Promise<WriteResult> {
  const { sql } = deps;
  const content = await prepareContent(deps, user, input, null);
  const flags = detectFlags({ previousBody: null, body: content.body, links: docLinkCount(content.content), trustLevel: user.trustLevel });
  const held = flags.length > 0 && !canReview(user.trustLevel);

  // A newcomer's story stays private (to them and reviewers) until a reviewer approves it.
  const storyStatus: StoryStatus = user.trustLevel >= TRUST.MEMBER ? 'active' : 'unreviewed';

  const result = await sql.begin(async (tx) => {
    if (!opts.skipDailyLimit) await assertWithinDailyLimit(tx, user, 'stories');
    const [story] = await tx<{ id: string }[]>`
      INSERT INTO stories (status, created_by, import_key, import_batch)
      VALUES (${storyStatus}, ${user.id}, ${opts.importKey ?? null}, ${opts.importBatch ?? null})
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
      origin: 'create',
    });
    if (!held) await applyRevision(tx, storyId, { id: revisionId });
    if (!held && storyStatus === 'active') await markPublished(tx, storyId, revisionId);
    return { storyId, revisionId, status: held ? 'pending' : 'live', storyStatus } as const;
  });
  if (!held) await refreshTrust(sql, user.id);
  return result;
}

/** JSON with object keys sorted, so values read back from jsonb (which reorders keys) compare equal. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([x], [y]) => x.localeCompare(y)))
      : v);

const sameContent = (a: Content, b: RevisionRow) =>
  canonical([a.title, a.summary, a.content, a.categories, a.lat, a.lng, a.place_name, a.people, a.links, a.cells,
    a.start_year, a.start_month, a.start_day, a.end_year, a.end_month, a.end_day, a.is_ongoing, a.is_approx, a.sources]) ===
  canonical([b.title, b.summary, b.content ?? legacyDoc(b.body, b.imageKey, b.imageCredit), b.categories, b.lat, b.lng, b.placeName,
    b.people, b.links.map((l) => ({ storyId: l.storyId, relation: l.relation })), [...b.cells].sort(),
    b.startYear, b.startMonth, b.startDay, b.endYear, b.endMonth, b.endDay, b.isOngoing, b.isApprox,
    b.sources.map((s) => ({ title: s.title, url: s.url ?? null }))]);

export async function editStory(
  deps: StoryDeps,
  user: SessionUser,
  storyId: string,
  input: EditStoryData,
  opts: SystemWriteOptions = {},
): Promise<WriteResult> {
  const { sql } = deps;
  const content = await prepareContent(deps, user, input, storyId);

  const result = await sql.begin(async (tx) => {
    if (!opts.skipDailyLimit) await assertWithinDailyLimit(tx, user, 'edits');
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
      origin: 'edit',
    });
    if (live) await applyRevision(tx, storyId, { id: revisionId });
    return { storyId, revisionId, status: live ? 'live' : 'pending', storyStatus: story.status } as const;
  });
  if (result.status === 'live') await refreshTrust(sql, user.id);
  return result;
}

/** Whether saving `input` would change the story's current version (what editStory calls "Nothing changed"). */
export async function differsFromCurrent(deps: StoryDeps, user: SessionUser, storyId: string, input: StoryInput): Promise<boolean> {
  const story = await fetchStory(deps.sql, storyId);
  if (!story?.currentRevisionId) return true;
  const current = await fetchRevision(deps.sql, story.currentRevisionId);
  if (!current) return true;
  return !sameContent(await prepareContent(deps, user, input, storyId), current);
}

/**
 * Importer only: fills in the links of a version that the same import run just created (and that is
 * still current), once the stories it links to exist. Nobody has seen that version without its links
 * yet, so this completes it rather than rewriting history; then the link index is rebuilt.
 */
export async function fillImportedLinks(tx: Db, storyId: string, revisionId: string, links: { storyId: string; relation: LinkRelation }[]): Promise<void> {
  const [row] = await tx`
    UPDATE story_revisions SET links = ${tx.json(links)}
    WHERE id = ${revisionId} AND story_id = ${storyId}
      AND id = (SELECT current_revision_id FROM stories WHERE id = ${storyId})
    RETURNING id`;
  if (row) await applyRevision(tx, storyId, { id: revisionId });
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
      if (story.status === 'hidden') throw conflict('This story is hidden. Bring it back before accepting edits to it.');
      // Protection decides who can put changes live, by editing or by accepting someone else's edit.
      if (user.trustLevel < liveEditThreshold(story.protectionLevel)) {
        throw forbidden('This story is protected: only a moderator can accept edits to it.');
      }
      if (story.currentRevisionId !== rev.parentRevisionId) {
        throw conflict('The story changed after this edit was made. Reject it and let the author resubmit.', 'stale');
      }
      await applyRevision(tx, rev.storyId, rev);
      // Accepting the first version of a story waiting for approval is approving the story: the
      // reviewer has just read all of it.
      if (story.status === 'unreviewed' && rev.parentRevisionId === null) {
        await tx`UPDATE stories SET status = 'active' WHERE id = ${rev.storyId}`;
        await markPublished(tx, rev.storyId, rev.id);
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
  invalidateMapCache();
  await refreshTrust(sql, authorId);
}

/**
 * Copies an earlier version into a new current revision, so history stays linear and append-only.
 * The copy is attributed to whoever made it but isn't counted as their edit. The caller holds the
 * story's row lock.
 */
export async function copyToNewRevision(
  tx: Db,
  story: StoryRow,
  sourceId: string,
  actorId: string,
  summary: string,
  origin: 'restore' | 'rollback',
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO story_revisions (story_id, parent_revision_id, author_id, title, body, content, image_key, image_credit, cells,
      start_year, start_month, start_day, end_year, end_month, end_day, is_ongoing, is_approx, sources,
      summary, categories, lat, lng, place_name, people, links,
      status, edit_summary, reviewed_by, reviewed_at, origin)
    SELECT story_id, ${story.currentRevisionId}, ${actorId}, title, body, content, image_key, image_credit, cells,
      start_year, start_month, start_day, end_year, end_month, end_day, is_ongoing, is_approx, sources,
      summary, categories, lat, lng, place_name, people, links,
      'accepted', ${summary}, ${actorId}, now(), ${origin}
    FROM story_revisions WHERE id = ${sourceId} AND story_id = ${story.id}
    RETURNING id, cells`;
  if (!row) throw notFound('Version');
  await applyRevision(tx, story.id, row);
  return row.id;
}

/**
 * `baseRevisionId` is the version that was current when the reviewer chose to restore: if the story has
 * moved on since (another restore, a double click), nothing is copied (409).
 */
export async function restoreRevision(
  { sql }: StoryDeps,
  user: SessionUser,
  storyId: string,
  revisionId: string,
  baseRevisionId?: string | null,
): Promise<WriteResult> {
  if (!canReview(user.trustLevel)) throw forbidden();
  return sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (user.trustLevel < liveEditThreshold(story.protectionLevel)) throw forbidden('This story is protected.');
    if (baseRevisionId && baseRevisionId !== story.currentRevisionId) {
      throw conflict('The story changed since you opened this page. Reload and check before restoring.', 'stale');
    }
    const old = await fetchRevision(tx, revisionId);
    // Removed versions are out of the history for good.
    if (!old || old.storyId !== storyId || old.hiddenAt) throw notFound('Version');
    // Only versions that were live once can be restored; pending ones go through review instead.
    if (old.status !== 'accepted') throw badRequest('Only versions that were accepted can be restored.');
    if (old.id === story.currentRevisionId) throw badRequest('That is already the current version.');

    const newId = await copyToNewRevision(tx, story, revisionId, user.id, `Restored the version from ${old.createdAt.toISOString().slice(0, 10)}`, 'restore');
    await logModAction(tx, user.id, 'restore', 'story', storyId, null, { revisionId, newRevisionId: newId });
    return { storyId, revisionId: newId, status: 'live', storyStatus: story.status } as const;
  });
}

/**
 * Approve (publish) a story waiting for review, hide a story, or (moderators) bring a hidden one back.
 * `revisionId` is the version the reviewer read: approval fails if the author changed it since, or if
 * someone already decided (published or rejected) the story. Bringing back a story that was never
 * published returns it to the review queue rather than publishing it. Returns the new status.
 */
export async function setStoryStatus(
  sql: Sql,
  user: SessionUser,
  storyId: string,
  status: 'active' | 'hidden',
  reason: string | null,
  revisionId?: string | null,
): Promise<StoryStatus> {
  if (!canReview(user.trustLevel)) throw forbidden();
  const result = await sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (status === 'hidden') {
      if (story.status === 'hidden') throw conflict('This story is already hidden.', 'already-decided');
      await tx`UPDATE stories SET status = 'hidden', updated_at = now() WHERE id = ${storyId}`;
      await closeReportsAbout(tx, user.id, 'story', [storyId]);
      await logModAction(tx, user.id, 'hide', 'story', storyId, reason);
      return { status: 'hidden' as StoryStatus, approvedCreator: null };
    }

    // An approval (it carries the version read) never un-hides: someone already rejected the story.
    if (revisionId && story.status !== 'unreviewed') {
      throw conflict(story.status === 'hidden' ? 'A reviewer already rejected this story.' : 'This story is already published.', 'already-decided');
    }
    if (story.status === 'active') throw conflict('This story is already published.', 'already-decided');

    if (story.status === 'hidden') {
      if (user.trustLevel < TRUST.MODERATOR) throw forbidden('Only moderators can bring back a hidden story.');
      if (!story.currentRevisionId) throw conflict('Its first version was never accepted, so there is nothing to bring back.');
      const [current] = await tx<{ hiddenAt: Date | null }[]>`SELECT hidden_at FROM story_revisions WHERE id = ${story.currentRevisionId}`;
      if (current?.hiddenAt) throw conflict('Its current version was removed. Restore another version before bringing it back.');
      const next: StoryStatus = story.publishedAt ? 'active' : 'unreviewed';
      await tx`UPDATE stories SET status = ${next}, updated_at = now() WHERE id = ${storyId}`;
      await logModAction(tx, user.id, 'unhide', 'story', storyId, reason, { to: next });
      return { status: next, approvedCreator: null };
    }

    // Approving a story waiting for review.
    if (!story.currentRevisionId) {
      const [first] = await tx<{ status: RevisionStatus }[]>`
        SELECT status FROM story_revisions WHERE story_id = ${storyId} ORDER BY created_at LIMIT 1`;
      throw conflict(
        first?.status === 'rejected'
          ? 'Its first version was turned down, so there is nothing to publish.'
          : 'Its first version is still waiting for review. Accept that version to publish the story.',
      );
    }
    if (story.createdBy === user.id) throw forbidden('You cannot approve your own story.');
    if (revisionId && revisionId !== story.currentRevisionId) {
      throw conflict('The author changed this story after you opened it. Take another look before approving.', 'stale');
    }
    await tx`UPDATE stories SET status = 'active', updated_at = now() WHERE id = ${storyId}`;
    await markPublished(tx, storyId, story.currentRevisionId);
    await logModAction(tx, user.id, 'approve', 'story', storyId, reason);
    return { status: 'active' as StoryStatus, approvedCreator: story.createdBy };
  });
  invalidateMapCache();
  // Contributions only count toward promotion once the story is published.
  if (result.approvedCreator) await refreshTrust(sql, result.approvedCreator);
  return result.status;
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
export async function closeReportsAbout(
  tx: Db,
  actorId: string,
  targetType: 'story' | 'revision' | 'user' | 'development' | 'correction' | 'collection',
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await tx`
    UPDATE reports SET resolved_by = ${actorId}, resolved_at = now(), resolution = 'actioned'
    WHERE resolved_at IS NULL AND target_type = ${targetType} AND target_id IN ${tx(ids)}
    RETURNING id`;
  return rows.length;
}

export async function setProtection(sql: Sql, user: SessionUser, storyId: string, level: TrustLevel, reason: string | null = null) {
  if (user.trustLevel < TRUST.MODERATOR) throw forbidden();
  await sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (story.protectionLevel === level) return;
    await tx`UPDATE stories SET protection_level = ${level} WHERE id = ${storyId}`;
    await logModAction(tx, user.id, `protect:${level}`, 'story', storyId, reason, { from: story.protectionLevel });
  });
}

export async function pendingForReview({ sql, storage }: StoryDeps) {
  // Held edits to hidden stories and from banned people wait outside the queue (accepting them would
  // rewrite a hidden story or publish a banned person's work); they come back if that changes.
  const pending = await fetchRevisions(sql, sql`r.status = 'pending' AND r.hidden_at IS NULL
    AND u.banned_at IS NULL AND (SELECT s.status FROM stories s WHERE s.id = r.story_id) <> 'hidden'
    ORDER BY r.created_at LIMIT 50`);
  const parentIds = pending.map((r) => r.parentRevisionId).filter((id): id is string => !!id);
  const parents = parentIds.length ? await fetchRevisions(sql, sql`r.id IN ${sql(parentIds)}`) : [];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return pending.map((r) => ({
    revision: toRevision(storage, r),
    currentRevision: r.parentRevisionId && byId.has(r.parentRevisionId) ? toRevision(storage, byId.get(r.parentRevisionId)!) : null,
  }));
}

export type SummaryRow = Pick<RevisionRow, 'title' | 'imageKey' | 'startYear' | 'startMonth' | 'startDay' | 'endYear' | 'endMonth' | 'endDay' | 'isOngoing' | 'isApprox' | 'categories' | 'placeName'> & {
  storyId: string;
  storyStatus: StoryStatus;
  cellCount: number;
  sourceCount: number;
  summary: string;
  publishedAt: Date | null;
  lastUpdateAt: Date;
  featuredAt: Date | null;
  developing: boolean;
  isHistorical: boolean;
};

export function toSummary(storage: Storage, r: SummaryRow): StorySummary {
  return {
    id: r.storyId,
    title: r.title,
    summary: r.summary,
    thumbUrl: imageUrls(storage, r.imageKey).thumbUrl,
    ...datesOf(r),
    isOngoing: r.isOngoing,
    isApprox: r.isApprox,
    categories: r.categories,
    placeName: r.placeName,
    sourceCount: r.sourceCount,
    cellCount: r.cellCount,
    status: r.storyStatus,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    lastUpdateAt: r.lastUpdateAt.toISOString(),
    isHistorical: r.isHistorical,
    developing: r.developing,
    featured: !!r.featuredAt,
  };
}

/** Reviewers feature a published story on the home page, or take it off. */
export async function setFeatured(sql: Sql, user: SessionUser, storyId: string, featured: boolean, reason: string | null): Promise<void> {
  if (!canReview(user.trustLevel)) throw forbidden();
  await sql.begin(async (tx) => {
    const story = await fetchStory(tx, storyId, true);
    if (!story) throw notFound('Story');
    if (featured && story.status !== 'active') throw conflict('Only published stories can be featured.');
    if (featured === !!story.featuredAt) return;
    await tx`UPDATE stories SET featured_at = ${featured ? sql`now()` : null} WHERE id = ${storyId}`;
    await logModAction(tx, user.id, featured ? 'feature' : 'unfeature', 'story', storyId, reason);
  });
}

/** Newcomers' stories waiting for a reviewer to approve them, oldest first. */
export async function unreviewedStories({ sql, storage }: StoryDeps): Promise<UnreviewedStory[]> {
  const rows = await sql<(SummaryRow & { revisionId: string; authorId: string; authorName: string; excerpt: string; createdAt: Date })[]>`
    SELECT ${summaryColumns(sql)}, s.created_at, r.id AS revision_id,
           left(r.body, 280) AS excerpt, u.id AS author_id, u.display_name AS author_name
    FROM stories s
    JOIN story_revisions r ON r.id = s.current_revision_id
    JOIN users u ON u.id = s.created_by
    WHERE s.status = 'unreviewed' AND u.banned_at IS NULL
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

/**
 * Stories a user started, newest first, including ones that are not public. For a hidden story,
 * non-reviewers see the person's own first version, not whatever the story currently says.
 */
export async function storiesStartedBy(
  { sql, storage }: StoryDeps,
  userId: string,
  offset: number,
  viewerIsReviewer: boolean,
  limit = 30,
): Promise<Page<ContributionStory>> {
  const rows = await sql<(SummaryRow & { createdAt: Date; hasCurrent: boolean; revisionStatus: RevisionStatus; published: boolean })[]>`
    SELECT ${summaryColumns(sql)}, s.created_at, s.current_revision_id IS NOT NULL AS has_current,
           s.published_at IS NOT NULL AS published, r.status AS revision_status
    FROM stories s
    JOIN story_revisions r ON r.id = CASE
      WHEN s.current_revision_id IS NOT NULL AND (s.status <> 'hidden' OR ${viewerIsReviewer}) THEN s.current_revision_id
      ELSE (SELECT f.id FROM story_revisions f WHERE f.story_id = s.id ORDER BY f.created_at LIMIT 1) END
    WHERE s.created_by = ${userId}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const items = rows.slice(0, limit).map((r) => ({
    story: toSummary(storage, r),
    state:
      // Rejected in review before it was ever public reads as "not accepted", not "hidden".
      (r.storyStatus === 'hidden' && !r.published) || (!r.hasCurrent && r.revisionStatus === 'rejected') ? ('rejected' as const)
      : r.storyStatus === 'hidden' ? ('hidden' as const)
      : r.storyStatus === 'active' && r.hasCurrent ? ('live' as const)
      : ('waiting' as const),
    createdAt: r.createdAt.toISOString(),
  }));
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}

/** Every version a user wrote (not copies they made by restoring), newest first. */
export async function revisionsBy(sql: Sql, userId: string, offset: number, viewerIsReviewer: boolean, limit = 50): Promise<Page<ContributionEdit>> {
  const rows = await sql<
    { id: string; storyId: string; storyTitle: string; storyStatus: StoryStatus; isFirst: boolean; status: RevisionStatus; isCurrent: boolean;
      hiddenAt: Date | null; editSummary: string | null; flags: string[]; createdAt: Date }[]
  >`
    SELECT r.id, r.story_id,
           CASE WHEN s.status = 'hidden' AND NOT ${viewerIsReviewer} THEN r.title ELSE COALESCE(cur.title, r.title) END AS story_title,
           s.status AS story_status, r.parent_revision_id IS NULL AS is_first,
           r.status, COALESCE(s.current_revision_id = r.id, false) AS is_current, r.hidden_at, r.edit_summary, r.flags, r.created_at
    FROM story_revisions r
    JOIN stories s ON s.id = r.story_id
    LEFT JOIN story_revisions cur ON cur.id = s.current_revision_id
    WHERE r.author_id = ${userId} AND r.origin IN ('create', 'edit')
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const items = rows.slice(0, limit).map(({ hiddenAt, createdAt, ...r }) => ({
    ...r,
    removed: !!hiddenAt,
    createdAt: createdAt.toISOString(),
  }));
  return { items, nextOffset: rows.length > limit ? offset + limit : null };
}
