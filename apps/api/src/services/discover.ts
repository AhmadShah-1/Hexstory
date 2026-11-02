import type { DiscoverData, StorySummary } from '@hexstory/shared';
import type { Db } from '../db.js';
import { homeCollections } from './collections.js';
import { hiKeySql, significanceSql, summaryColumns, toSummary, type StoryDeps, type SummaryRow } from './stories.js';

const SECTION = 6;
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; data: DiscoverData }>();

export function invalidateDiscover(): void {
  cache.clear();
}

/**
 * The guided-discovery home panel. Everything here is public and the same for everyone (on a given
 * day), so it is cached per instance and by the CDN; a young site with few stories gets short sections
 * rather than empty, "nobody here" ones (the client hides empty sections).
 */
export async function discover(deps: StoryDeps, today: { month: number; day: number }): Promise<DiscoverData> {
  const key = `${today.month}-${today.day}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const { sql, storage } = deps;

  const section = async (where: ReturnType<Db>, order: ReturnType<Db>, limit = SECTION): Promise<StorySummary[]> => {
    const rows = await sql<SummaryRow[]>`
      SELECT ${summaryColumns(sql)}
      FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id
      WHERE s.status = 'active' AND ${where}
      ORDER BY ${order}, s.id
      LIMIT ${limit}`;
    return rows.map((r) => toSummary(storage, r));
  };
  const [featured, developing, discoveries, recent, onThisDay, collections, total] = await Promise.all([
    section(sql`s.featured_at IS NOT NULL`, sql`s.featured_at DESC`),
    section(
      sql`(r.is_ongoing OR EXISTS (SELECT 1 FROM story_developments d WHERE d.story_id = s.id AND d.status = 'accepted' AND d.hidden_at IS NULL
        AND d.created_at > now() - interval '30 days'))`,
      sql`s.last_update_at DESC`,
    ),
    section(
      sql`NOT r.is_ongoing AND ${hiKeySql(sql)} < to_char(COALESCE(s.published_at, s.created_at) - interval '365 days', 'YYYYMMDD')::int`,
      sql`COALESCE(s.published_at, s.created_at) DESC`,
    ),
    section(
      sql`NOT (NOT r.is_ongoing AND ${hiKeySql(sql)} < to_char(COALESCE(s.published_at, s.created_at) - interval '365 days', 'YYYYMMDD')::int)`,
      sql`COALESCE(s.published_at, s.created_at) DESC`,
    ),
    section(
      sql`((r.start_month = ${today.month} AND r.start_day = ${today.day}) OR (r.end_month = ${today.month} AND r.end_day = ${today.day}))`,
      sql`${significanceSql(sql)} DESC, r.start_year`,
    ),
    homeCollections(sql, SECTION),
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM stories WHERE status = 'active'`.then(([r]) => r?.n ?? 0),
  ]);

  // Until reviewers feature stories, the most connected well-sourced ones stand in.
  const picked = featured.length >= 3
    ? featured
    : [...featured, ...(await section(sql`s.featured_at IS NULL`, sql`${significanceSql(sql)} DESC, s.last_update_at DESC`, SECTION - featured.length))];

  const data: DiscoverData = { featured: picked, developing, discoveries, recent, onThisDay, collections, total };
  if (cache.size > 400) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
}
