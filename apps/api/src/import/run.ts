import { readFile, stat } from 'node:fs/promises';
import { TRUST, type StoryInput } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Sql } from '../db.js';
import { addDevelopment } from '../services/developments.js';
import { encodeImage } from '../services/images.js';
import { logModAction } from '../services/modlog.js';
import { createStory, differsFromCurrent, editStory, fillImportedLinks, invalidateMapCache } from '../services/stories.js';
import { imageFileNames, type Storage } from '../storage/index.js';
import { PHOTO_BYTES_MAX, developmentKey, photoKey, toDevelopmentInput, toStoryInput, type Issue, type ParsedRecord } from './format.js';

/** The account imported stories are written by: visible on every story, never able to sign in. */
export const ARCHIVE = { googleSub: 'system:hexstory-archive', displayName: 'Hexstory Archive' };

export async function archiveUser(sql: Sql): Promise<SessionUser> {
  // Reviewer level so imports go live without review; locked so automatic promotion never touches it.
  await sql`
    INSERT INTO users (google_sub, email, display_name, trust_level, trust_locked, terms_accepted_at)
    VALUES (${ARCHIVE.googleSub}, NULL, ${ARCHIVE.displayName}, ${TRUST.REVIEWER}, true, now())
    ON CONFLICT (google_sub) DO NOTHING`;
  const [u] = await sql<SessionUser[]>`
    SELECT id, email, display_name, trust_level, terms_accepted_at, banned_at, created_at FROM users WHERE google_sub = ${ARCHIVE.googleSub}`;
  return u!;
}

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  /** Changed on the site by someone since it was imported: left alone unless `updateEdited`. */
  skippedEdited: string[];
  developmentsAdded: number;
  photosStored: number;
  failed: Issue[];
}

/** Existing imported stories by key, with who wrote their current version. */
export async function existingImports(sql: Sql, keys: string[]) {
  if (!keys.length) return new Map<string, { id: string; currentAuthor: string | null }>();
  const rows = await sql<{ id: string; importKey: string; currentAuthor: string | null }[]>`
    SELECT s.id, s.import_key, r.author_id AS current_author
    FROM stories s LEFT JOIN story_revisions r ON r.id = s.current_revision_id
    WHERE s.import_key IN ${sql(keys)}`;
  return new Map(rows.map((r) => [r.importKey, { id: r.id, currentAuthor: r.currentAuthor }]));
}

/** Runs `task` over items, `limit` at a time, in order of completion. */
async function pool<T>(items: T[], limit: number, task: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await task(items[i]!, i);
    }
  }));
}

/**
 * Writes validated records to the database through the same services the site uses, so the map
 * index, connections and timelines are built exactly as for stories written on the site.
 *
 * 1. Photos: re-encoded like uploads and stored under a key derived from their bytes (stored once).
 * 2. New stories are created, with connections to stories that already exist.
 * 3. Stories imported before are updated (a new version by the archive account) when the file changed,
 *    unless someone edited them on the site since (`updateEdited` overrides that).
 * 4. Connections between stories created in this run are filled in, now that they all exist.
 * 5. Timeline developments not imported before are added.
 *
 * Every story is its own transaction, so an interrupted run can simply be run again.
 */
export async function applyImport(
  deps: { sql: Sql; storage: Storage },
  records: ParsedRecord[],
  opts: { batch: string; updateEdited?: boolean; concurrency?: number; log?: (msg: string) => void },
): Promise<ImportSummary> {
  const { sql, storage } = deps;
  const log = opts.log ?? (() => {});
  const concurrency = opts.concurrency ?? 4;
  const archive = await archiveUser(sql);
  const summary: ImportSummary = { created: 0, updated: 0, unchanged: 0, skippedEdited: [], developmentsAdded: 0, photosStored: 0, failed: [] };
  const fail = (where: string, err: unknown) => summary.failed.push({ level: 'error', where, message: (err as Error).message });

  // 1. Photos
  const imageKeys = new Map<string, string>();
  await pool(records.filter((r) => r.photoPath), concurrency, async ({ record, photoPath, where }) => {
    try {
      const info = await stat(photoPath!);
      if (info.size > PHOTO_BYTES_MAX) throw new Error(`photo is larger than ${PHOTO_BYTES_MAX / 1024 / 1024} MB`);
      const bytes = await readFile(photoPath!);
      const key = photoKey(bytes);
      const names = imageFileNames(key);
      if (!(await storage.exists(names.full))) {
        const { full, thumb } = await encodeImage(bytes);
        await Promise.all([storage.put(names.full, full, 'image/webp'), storage.put(names.thumb, thumb, 'image/webp')]);
        summary.photosStored++;
      }
      imageKeys.set(record.key, key);
    } catch (err) {
      fail(where, new Error(`photo ${record.photo!.file}: ${(err as Error).message}`));
    }
  });

  const existing = await existingImports(sql, records.map((r) => r.record.key));
  // Keys of stories that existed before this run, plus links' targets imported earlier.
  const linkTargets = await existingImports(sql, [...new Set(records.flatMap((r) => r.record.links.map((l) => l.key)))]);
  const ids = new Map<string, string>([...linkTargets, ...existing].map(([k, v]) => [k, v.id]));
  const input = (r: ParsedRecord): StoryInput => toStoryInput(r.record, ids, imageKeys.get(r.record.key) ?? null);

  // 2. New stories
  const created: { record: ParsedRecord; storyId: string; revisionId: string }[] = [];
  const fresh = records.filter((r) => !existing.has(r.record.key));
  await pool(fresh, concurrency, async (r, i) => {
    try {
      const res = await createStory(deps, archive, input(r), { skipDailyLimit: true, importKey: r.record.key, importBatch: opts.batch });
      ids.set(r.record.key, res.storyId);
      created.push({ record: r, storyId: res.storyId, revisionId: res.revisionId });
      summary.created++;
    } catch (err) {
      fail(r.where, err);
    }
    if ((i + 1) % 100 === 0) log(`  created ${i + 1}/${fresh.length}`);
  });

  // 3. Updates (every link target exists now)
  await pool(records.filter((r) => existing.has(r.record.key)), concurrency, async (r) => {
    const { id, currentAuthor } = existing.get(r.record.key)!;
    try {
      const next = input(r);
      if (!(await differsFromCurrent(deps, archive, id, next))) {
        summary.unchanged++;
        return;
      }
      if (currentAuthor && currentAuthor !== archive.id && !opts.updateEdited) {
        summary.skippedEdited.push(r.record.key);
        return;
      }
      const [cur] = await sql<{ currentRevisionId: string }[]>`SELECT current_revision_id FROM stories WHERE id = ${id}`;
      await editStory(deps, archive, id, { ...next, baseRevisionId: cur!.currentRevisionId, editSummary: `Updated from import batch "${opts.batch}"` }, { skipDailyLimit: true });
      summary.updated++;
    } catch (err) {
      fail(r.where, err);
    }
  });

  // 4. Connections between stories created in this run
  await pool(created.filter((c) => c.record.record.links.length), concurrency, async ({ record, storyId, revisionId }) => {
    try {
      const links = input(record).links;
      await sql.begin((tx) => fillImportedLinks(tx, storyId, revisionId, links));
    } catch (err) {
      fail(record.where, err);
    }
  });

  // 5. Timeline developments
  const devs = records.flatMap((r) => (ids.has(r.record.key) ? r.record.developments.map((d) => ({ r, d, key: developmentKey(r.record.key, d) })) : []));
  const known = devs.length
    ? new Set((await sql<{ importKey: string }[]>`SELECT import_key FROM story_developments WHERE import_key IN ${sql(devs.map((d) => d.key))}`).map((x) => x.importKey))
    : new Set<string>();
  await pool(devs.filter((d) => !known.has(d.key)), concurrency, async ({ r, d, key }) => {
    try {
      await addDevelopment(deps, archive, ids.get(r.record.key)!, toDevelopmentInput(d), { skipDailyLimit: true, importKey: key });
      summary.developmentsAdded++;
    } catch (err) {
      fail(`${r.where} development "${d.title}"`, err);
    }
  });

  invalidateMapCache();
  return summary;
}

/** What `applyImport` would do, without writing anything. */
export async function planImport(deps: { sql: Sql; storage: Storage }, records: ParsedRecord[]) {
  const { sql } = deps;
  const archive = await sql<{ id: string }[]>`SELECT id FROM users WHERE google_sub = ${ARCHIVE.googleSub}`;
  const archiveId = archive[0]?.id ?? null;
  const existing = await existingImports(sql, records.map((r) => r.record.key));
  const plan = { create: 0, update: 0, unchanged: 0, editedOnSite: [] as string[], developments: 0 };
  const knownDevs = new Set(
    (await sql<{ importKey: string }[]>`SELECT import_key FROM story_developments WHERE import_key IS NOT NULL`).map((x) => x.importKey),
  );
  const ids = new Map([...existing].map(([k, v]) => [k, v.id]));
  for (const r of records) {
    plan.developments += r.record.developments.filter((d) => !knownDevs.has(developmentKey(r.record.key, d))).length;
    const found = existing.get(r.record.key);
    if (!found) {
      plan.create++;
      continue;
    }
    // Photos aren't stored during a dry run, so compare with the photo the story already has.
    const [cur] = await sql<{ imageKey: string | null }[]>`
      SELECT r.image_key FROM stories s JOIN story_revisions r ON r.id = s.current_revision_id WHERE s.id = ${found.id}`;
    const changed = await differsFromCurrent(deps, { id: archiveId ?? '00000000-0000-4000-8000-000000000000' } as SessionUser, found.id, toStoryInput(r.record, ids, r.photoPath ? cur?.imageKey ?? null : null))
      .catch(() => true);
    if (!changed) plan.unchanged++;
    else if (found.currentAuthor && found.currentAuthor !== archiveId) plan.editedOnSite.push(r.record.key);
    else plan.update++;
  }
  return plan;
}

/** Takes a whole import batch off the site (hidden, like a reviewer hiding a story; moderators can unhide). */
export async function removeBatch(sql: Sql, batch: string, reason: string): Promise<number> {
  const archive = await archiveUser(sql);
  const hidden = await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE stories SET status = 'hidden', updated_at = now() WHERE import_batch = ${batch} AND status <> 'hidden' RETURNING id`;
    for (const { id } of rows) await logModAction(tx, archive.id, 'hide', 'story', id, reason, { importBatch: batch });
    return rows.length;
  });
  invalidateMapCache();
  return hidden;
}
