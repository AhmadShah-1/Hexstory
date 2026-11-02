import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  CATEGORIES,
  LIMITS,
  LINK_RELATIONS,
  createDevelopmentSchema,
  createStorySchema,
  isHttpUrl,
  legacyDoc,
  type DateParts,
  type RichDoc,
  type StoryInput,
} from '@hexstory/shared';

/**
 * The import file format (docs/IMPORT.md): JSON Lines (one event per line) or a JSON array of events.
 * Each event becomes a story; its `developments` become the story's timeline. Validation runs the same
 * schemas the API enforces (createStorySchema, createDevelopmentSchema) plus import-only rules: a stable
 * key, a link on every source, keys for connections, and a freely licensed photo with attribution.
 */

export const PHOTO_LICENSES = [
  'public-domain', 'CC0', 'CC BY 2.0', 'CC BY 2.5', 'CC BY 3.0', 'CC BY 4.0',
  'CC BY-SA 2.0', 'CC BY-SA 2.5', 'CC BY-SA 3.0', 'CC BY-SA 4.0',
] as const;
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
export const PHOTO_BYTES_MAX = 25 * 1024 * 1024;

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** "2023", "2023-04", "2023-04-15"; a leading minus for BCE ("-44-03-15"). */
const DATE = /^(-?\d{1,5})(?:-(\d{2})(?:-(\d{2}))?)?$/;

const httpUrl = z.string().trim().max(LIMITS.sourceUrlMax).refine(isHttpUrl, 'must be an http(s) link');
const dateText = z.string().trim().regex(DATE, 'must look like 2023, 2023-04 or 2023-04-15 (minus sign for BCE)');
const source = z.object({ title: z.string().trim().min(1).max(LIMITS.sourceTitleMax), url: httpUrl }, { error: 'needs a title and a url' });
const location = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  place: z.string().trim().min(2).max(LIMITS.placeNameMax),
});

const photo = z.object({
  /** Path inside the photos folder, e.g. "sudan-war-2023.jpg". */
  file: z.string().trim().min(1).max(200),
  caption: z.string().trim().max(120).optional(),
  author: z.string().trim().min(1).max(100),
  license: z.string().trim().transform((v, ctx) => {
    const match = PHOTO_LICENSES.find((l) => l.toLowerCase() === v.toLowerCase().replace(/^pd$|^public domain$/, 'public-domain'));
    if (!match) ctx.addIssue({ code: 'custom', message: `licence must be one of: ${PHOTO_LICENSES.join(', ')}` });
    return match ?? v;
  }),
  /** The photo's own page (e.g. its Wikimedia Commons file page), for attribution. */
  source: httpUrl,
});

const development = z.object({
  date: dateText,
  title: z.string().trim(),
  details: z.string().trim().optional(),
  location: location.nullish(),
  sources: z.array(source).min(1, 'every development needs at least one source'),
});

export const importRecordSchema = z.object({
  key: z.string().trim().max(100).regex(KEY, 'key must be lowercase words joined by hyphens, e.g. "sudan-war-2023"'),
  title: z.string().trim(),
  summary: z.string().trim(),
  body: z.string().trim(),
  start: dateText,
  end: dateText.nullish(),
  ongoing: z.boolean().default(false),
  approximate: z.boolean().default(false),
  location,
  categories: z.array(z.enum(CATEGORIES, { error: `must be one of: ${CATEGORIES.join(', ')}` })),
  people: z.array(z.string().trim()).default([]),
  sources: z.array(source).min(1, 'every event needs at least one source with a link'),
  links: z.array(z.object({ key: z.string().trim().regex(KEY), relation: z.enum(LINK_RELATIONS) })).default([]),
  photo: photo.nullish(),
  developments: z.array(development).default([]),
});
export type ImportRecord = z.output<typeof importRecordSchema>;

export interface Issue {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

export interface ParsedRecord {
  record: ImportRecord;
  /** "file.jsonl:12" */
  where: string;
  /** Absolute path of the photo, if any. */
  photoPath: string | null;
}

export function parseDate(text: string): DateParts {
  const m = DATE.exec(text)!;
  return { year: Number(m[1]), month: m[2] ? Number(m[2]) : null, day: m[3] ? Number(m[3]) : null };
}

/** A stable, UUID-shaped image key from the photo's bytes, so importing the same photo twice stores it once. */
export function photoKey(bytes: Buffer): string {
  const h = createHash('sha256').update(bytes).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The story input for a record. `linkIds` maps import keys to story ids (unknown keys are left out);
 * `imageKey` is the stored photo's key (a placeholder while only checking).
 */
export function toStoryInput(r: ImportRecord, linkIds: Map<string, string>, imageKey: string | null): StoryInput {
  const content: RichDoc = legacyDoc(r.body, null, null);
  if (r.photo && imageKey) {
    const credit = `Photo: ${r.photo.author}, ${r.photo.license}`;
    const caption = (r.photo.caption ? `${r.photo.caption} (${credit})` : credit).slice(0, LIMITS.imageCreditMax);
    content.unshift({ type: 'image', key: imageKey, caption });
  }
  // The photo's page is listed as a source too, so its attribution has a link.
  const sources = [...r.sources];
  if (r.photo && imageKey) sources.push({ title: `Photo: ${r.photo.caption ?? r.title} by ${r.photo.author} (${r.photo.license})`.slice(0, LIMITS.sourceTitleMax), url: r.photo.source });
  return createStorySchema.parse({
    title: r.title,
    summary: r.summary,
    content,
    categories: r.categories,
    location: { lat: r.location.lat, lng: r.location.lng, placeName: r.location.place },
    cells: [],
    start: parseDate(r.start),
    end: r.end ? parseDate(r.end) : null,
    isOngoing: r.ongoing,
    isApprox: r.approximate,
    sources: sources.slice(0, LIMITS.sourcesMax),
    people: r.people,
    links: r.links.flatMap((l) => (linkIds.has(l.key) ? [{ storyId: linkIds.get(l.key)!, relation: l.relation }] : [])),
  });
}

export function toDevelopmentInput(d: ImportRecord['developments'][number]) {
  return createDevelopmentSchema.parse({
    date: parseDate(d.date),
    title: d.title,
    body: d.details ?? null,
    location: d.location ? { lat: d.location.lat, lng: d.location.lng, placeName: d.location.place } : null,
    sources: d.sources,
  });
}

/** Stable key for a development, so a re-import adds only new ones. */
export const developmentKey = (eventKey: string, d: ImportRecord['developments'][number]) =>
  `${eventKey}:${createHash('sha1').update(`${d.date}|${d.title.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`;

const zodIssues = (err: z.ZodError, where: string, prefix = ''): Issue[] =>
  err.issues.map((i) => ({ level: 'error', where, message: `${prefix}${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}` }));

/**
 * Reads and validates import files. Returns every record that parsed, and every problem found (errors
 * stop an import; warnings don't). Keys must be unique across all files. Links to keys that aren't in
 * the files are errors unless `knownKeys` (keys already in the database) contains them; without a
 * database they are warnings.
 */
export async function readImportFiles(
  files: string[],
  opts: { photosDir?: string; knownKeys?: Set<string> | null } = {},
): Promise<{ records: ParsedRecord[]; issues: Issue[] }> {
  const records: ParsedRecord[] = [];
  const issues: Issue[] = [];
  const add = (level: Issue['level'], where: string, message: string) => issues.push({ level, where, message });

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      add('error', file, 'cannot read this file');
      continue;
    }
    const name = basename(file);
    const photosDir = resolve(opts.photosDir ?? resolve(dirname(file), 'photos'));
    let items: { value: unknown; line: number }[];
    if (text.trimStart().startsWith('[')) {
      try {
        items = (JSON.parse(text) as unknown[]).map((value, i) => ({ value, line: i + 1 }));
      } catch (err) {
        add('error', name, `not valid JSON: ${(err as Error).message}`);
        continue;
      }
    } else {
      items = [];
      text.split('\n').forEach((raw, i) => {
        if (!raw.trim()) return;
        try {
          items.push({ value: JSON.parse(raw), line: i + 1 });
        } catch (err) {
          add('error', `${name}:${i + 1}`, `not valid JSON: ${(err as Error).message}`);
        }
      });
    }
    for (const { value, line } of items) {
      const key = (value as { key?: unknown })?.key;
      const where = `${name}:${line}${typeof key === 'string' ? ` [${key}]` : ''}`;
      const parsed = importRecordSchema.safeParse(value);
      if (!parsed.success) {
        issues.push(...zodIssues(parsed.error, where));
        continue;
      }
      let photoPath: string | null = null;
      if (parsed.data.photo) {
        const p = resolve(photosDir, parsed.data.photo.file);
        const rel = relative(photosDir, p);
        if (rel.startsWith('..') || isAbsolute(rel)) add('error', where, 'photo.file must be inside the photos folder');
        else if (!PHOTO_EXTENSIONS.includes(extname(p).toLowerCase())) add('error', where, `photo.file must be ${PHOTO_EXTENSIONS.join(', ')}`);
        else {
          const info = await stat(p).catch(() => null);
          if (!info?.isFile()) add('error', where, `photo.file not found: ${relative(process.cwd(), p)}`);
          else if (info.size > PHOTO_BYTES_MAX) add('error', where, `photo is larger than ${PHOTO_BYTES_MAX / 1024 / 1024} MB`);
          else photoPath = p;
        }
      }
      records.push({ record: parsed.data, where, photoPath });
    }
  }

  // Keys are unique across all files; titles in the same year probably describe the same event.
  const byKey = new Map<string, ParsedRecord>();
  const byTitle = new Map<string, string>();
  for (const r of records) {
    const prev = byKey.get(r.record.key);
    if (prev) add('error', r.where, `duplicate key (also at ${prev.where})`);
    else byKey.set(r.record.key, r);
    const titleKey = `${r.record.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${parseDate(r.record.start).year}`;
    if (byTitle.has(titleKey)) add('warning', r.where, `same title and year as ${byTitle.get(titleKey)}: is this the same event?`);
    else byTitle.set(titleKey, r.where);
  }

  // Run the site's own validation on what each record will become, with placeholder ids.
  const ids = new Map([...byKey.keys(), ...(opts.knownKeys ?? [])].map((k) => [k, PLACEHOLDER_ID.slice(0, 24) + createHash('md5').update(k).digest('hex').slice(0, 12)]));
  for (const { record: r, where, photoPath } of records) {
    for (const l of r.links) {
      if (l.key === r.key) add('error', where, 'links: a story cannot link to itself');
      else if (!ids.has(l.key)) {
        add(opts.knownKeys ? 'error' : 'warning', where, `links: no event with key "${l.key}" ${opts.knownKeys ? 'in the files or the database' : 'in these files (fine only if it was imported before)'}`);
      }
    }
    try {
      toStoryInput(r, ids, photoPath ? PLACEHOLDER_ID : null);
    } catch (err) {
      if (err instanceof z.ZodError) issues.push(...zodIssues(err, where));
      else throw err;
    }
    const start = parseDate(r.start);
    r.developments.forEach((d, i) => {
      try {
        toDevelopmentInput(d);
      } catch (err) {
        if (err instanceof z.ZodError) issues.push(...zodIssues(err, where, `developments.${i}.`));
        else throw err;
      }
      if (DATE.test(d.date) && parseDate(d.date).year < start.year) add('warning', where, `developments.${i}: dated before the event starts`);
    });
    if (r.developments.length && !r.ongoing && !r.end) add('warning', where, 'has developments but is neither ongoing nor given an end date');
    if (!r.photo) add('warning', where, 'no photo (one freely licensed photo per story is preferred)');
    else if (!/^https:\/\/commons\.wikimedia\.org\//.test(r.photo.source)) add('warning', where, 'photo.source is not a Wikimedia Commons page: make sure the licence really allows reuse');
  }
  return { records, issues };
}
