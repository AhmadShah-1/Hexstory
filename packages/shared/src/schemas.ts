import { z } from 'zod';
import { compareDateParts, daysInMonth } from './dates.js';
import { isDisplayCell } from './hex.js';
import { CATEGORIES, LINK_RELATIONS, STORY_KINDS, STORY_SORTS } from './history.js';
import { LIMITS } from './limits.js';
import { richDocSchema } from './richtext.js';

const MIN_YEAR = -50_000;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const trimmed = (min: number, max: number, tooShort?: string) =>
  z.string().trim().min(min, tooShort).max(max, `Keep it under ${max.toLocaleString('en')} characters`);

export const datePartsSchema = z
  .object({
    year: z
      .number({ error: 'Enter the year' })
      .int('Enter a whole year')
      .min(MIN_YEAR, 'That year is too far back')
      .refine((y) => y !== 0, 'There is no year 0'),
    month: z.number().int().min(1).max(12).nullish(),
    day: z.number().int().min(1).max(31).nullish(),
  })
  .refine((d) => d.year <= new Date().getUTCFullYear(), { message: 'Date is in the future', path: ['year'] })
  .refine((d) => !d.day || !!d.month, { message: 'A day needs a month', path: ['day'] })
  .refine((d) => !d.day || !d.month || d.day <= daysInMonth(d.year, d.month), {
    message: 'That day does not exist in this month',
    path: ['day'],
  });

export const sourceSchema = z.object({
  title: trimmed(1, LIMITS.sourceTitleMax, 'Each source needs a title or a link'),
  url: z
    .string()
    .trim()
    .max(LIMITS.sourceUrlMax)
    .refine((v) => v === '' || isHttpUrl(v), 'Links must start with http:// or https://')
    .transform((v) => v || null)
    .nullish(),
});
export type Source = z.infer<typeof sourceSchema>;

/** A precise point for an event; the hexagon grid is only how the map draws it. */
export const locationSchema = z.object(
  {
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    placeName: z.string().trim().max(LIMITS.placeNameMax).transform((v) => v || null).nullish(),
  },
  { error: 'Pick where it happened on the map' },
);
export type Location = z.infer<typeof locationSchema>;

const sourcesSchema = z
  .array(sourceSchema)
  .min(LIMITS.sourcesMin, 'Add at least one source')
  .max(LIMITS.sourcesMax, `At most ${LIMITS.sourcesMax} sources`);

export const storyLinkSchema = z.object({ storyId: z.uuid(), relation: z.enum(LINK_RELATIONS) });
export type StoryLinkInput = z.infer<typeof storyLinkSchema>;

const storyFields = z.object({
  title: trimmed(LIMITS.titleMin, LIMITS.titleMax, `Give it a title of at least ${LIMITS.titleMin} characters`),
  summary: trimmed(LIMITS.summaryMin, LIMITS.summaryMax, `Sum it up in at least ${LIMITS.summaryMin} characters`),
  content: richDocSchema,
  categories: z
    .array(z.enum(CATEGORIES))
    .min(LIMITS.categoriesMin, 'Pick at least one category')
    .max(LIMITS.categoriesMax, `Pick at most ${LIMITS.categoriesMax} categories`)
    .transform((c) => [...new Set(c)]),
  location: locationSchema,
  /** Optional wider area the event covers. Without one, the story is indexed at its point. */
  cells: z
    .array(z.string().refine(isDisplayCell, 'Invalid region'))
    .max(LIMITS.cellsMax, 'That area is too large. Pick fewer or smaller regions')
    .default([]),
  start: datePartsSchema,
  end: datePartsSchema.nullish(),
  isOngoing: z.boolean().default(false),
  isApprox: z.boolean().default(false),
  sources: sourcesSchema,
  people: z
    .array(trimmed(LIMITS.personNameMin, LIMITS.personNameMax, 'Names need at least 2 characters'))
    .max(LIMITS.peopleMax, `At most ${LIMITS.peopleMax} people`)
    .default([])
    .transform((names) => [...new Map(names.map((n) => [n.toLowerCase(), n])).values()]),
  links: z
    .array(storyLinkSchema)
    .max(LIMITS.linksMax, `At most ${LIMITS.linksMax} connections`)
    .default([])
    .refine((links) => new Set(links.map((l) => l.storyId)).size === links.length, 'Each story can be connected once'),
});

const withDateRules = <T extends z.ZodType<z.infer<typeof storyFields>>>(schema: T) =>
  schema
    .refine((s) => !(s.isOngoing && s.end), { message: 'An ongoing event has no end date', path: ['end'] })
    .refine((s) => !s.end || compareDateParts(s.end, s.start) >= 0, {
      message: 'End date is before the start date',
      path: ['end'],
    });

export const createStorySchema = withDateRules(storyFields);
export type CreateStoryInput = z.input<typeof createStorySchema>;
export type StoryInput = z.output<typeof createStorySchema>;

export const editStorySchema = withDateRules(
  storyFields.extend({
    baseRevisionId: z.uuid(),
    editSummary: z.string().trim().max(LIMITS.editSummaryMax).nullish(),
  }),
);
export type EditStoryInput = z.input<typeof editStorySchema>;
export type EditStoryData = z.output<typeof editStorySchema>;

/** One development in an event's timeline: its own date, place and sources. */
export const createDevelopmentSchema = z.object({
  date: datePartsSchema,
  title: trimmed(LIMITS.developmentTitleMin, LIMITS.developmentTitleMax, `Give it a headline of at least ${LIMITS.developmentTitleMin} characters`),
  body: z.string().trim().max(LIMITS.developmentBodyMax).transform((v) => v || null).nullish(),
  location: locationSchema.nullish(),
  sources: sourcesSchema,
});
export type CreateDevelopmentInput = z.input<typeof createDevelopmentSchema>;

export const CORRECTION_PROBLEMS = ['inaccurate', 'missing-context', 'unsupported', 'outdated'] as const;
export type CorrectionProblem = (typeof CORRECTION_PROBLEMS)[number];
export const CORRECTION_PROBLEM_LABELS: Record<CorrectionProblem, string> = {
  inaccurate: 'Factually wrong',
  'missing-context': 'Missing important context',
  unsupported: 'Not supported by the sources',
  outdated: 'Out of date',
};

/** A reader disputing one statement in a specific version, with a proposed fix and counter-evidence. */
export const createCorrectionSchema = z.object({
  revisionId: z.uuid(),
  quote: trimmed(LIMITS.correctionQuoteMin, LIMITS.correctionQuoteMax, 'Quote the statement you are disputing'),
  problem: z.enum(CORRECTION_PROBLEMS),
  proposal: trimmed(LIMITS.correctionProposalMin, LIMITS.correctionProposalMax, 'Say what it should say instead, and why'),
  evidence: sourcesSchema,
});
export type CreateCorrectionInput = z.input<typeof createCorrectionSchema>;

export const resolveCorrectionSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  note: trimmed(1, LIMITS.correctionNoteMax, 'Explain the decision so readers can follow it'),
  /** The version that applied the fix, when it was accepted and the story already edited. */
  fixedRevisionId: z.uuid().nullish(),
});

export const COLLECTION_KINDS = ['place', 'theme'] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

/**
 * A narrative grouping of stories. Stories are picked by hand (`items`) and/or gathered
 * automatically by rules: an area (place collections), categories and a span of years.
 */
export const collectionSchema = z
  .object({
    title: trimmed(LIMITS.collectionTitleMin, LIMITS.collectionTitleMax, `Give it a title of at least ${LIMITS.collectionTitleMin} characters`),
    description: trimmed(LIMITS.collectionDescriptionMin, LIMITS.collectionDescriptionMax, `Describe it in at least ${LIMITS.collectionDescriptionMin} characters`),
    kind: z.enum(COLLECTION_KINDS),
    cells: z.array(z.string().refine(isDisplayCell, 'Invalid region')).max(LIMITS.collectionCellsMax).default([]),
    categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).default([]),
    fromYear: z.number().int().min(-50_000).refine((y) => y !== 0, 'There is no year 0').nullish(),
    toYear: z.number().int().min(-50_000).refine((y) => y !== 0, 'There is no year 0').nullish(),
    items: z
      .array(z.object({ storyId: z.uuid(), note: z.string().trim().max(LIMITS.collectionNoteMax).transform((v) => v || null).nullish() }))
      .max(LIMITS.collectionItemsMax, `At most ${LIMITS.collectionItemsMax} hand-picked stories`)
      .default([])
      .refine((items) => new Set(items.map((i) => i.storyId)).size === items.length, 'Each story can be added once'),
  })
  .refine((c) => c.fromYear == null || c.toYear == null || c.toYear >= c.fromYear, { message: 'The end year is before the start year', path: ['toYear'] })
  .refine((c) => c.kind !== 'place' || c.cells.length > 0, { message: 'Pick the area this place covers', path: ['cells'] })
  .refine((c) => c.items.length > 0 || c.cells.length > 0 || c.categories.length > 0 || c.fromYear != null || c.toYear != null, {
    message: 'Add stories by hand, or say which stories belong (an area, categories or years)',
    path: ['items'],
  });
export type CollectionInput = z.input<typeof collectionSchema>;

/** Filters and ordering shared by every story list (explore, a region, a person, search). */
export const storyListQuerySchema = z.object({
  sort: z.enum(STORY_SORTS).default('occurred'),
  kind: z.enum(STORY_KINDS).default('all'),
  categories: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(z.enum(CATEGORIES))),
  from: z.coerce.number().int().min(-50_000).max(10_000).optional(),
  to: z.coerce.number().int().min(-50_000).max(10_000).optional(),
  cell: z.string().refine(isDisplayCell, 'Invalid region').optional(),
  q: z.string().trim().max(100).optional(),
  person: z.string().trim().max(LIMITS.personNameMax).optional(),
  ongoing: z.enum(['1']).optional(),
  /** "On this day": events that started or ended on this month and day ("MM-DD"). */
  on: z
    .string()
    .regex(/^\d{1,2}-\d{1,2}$/)
    .transform((v) => v.split('-').map(Number) as [number, number])
    .refine(([m, d]) => m >= 1 && m <= 12 && d >= 1 && d <= 31, 'Invalid date')
    .optional(),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type StoryListQuery = z.input<typeof storyListQuerySchema>;

export const displayNameSchema = z
  .string()
  .trim()
  .min(LIMITS.displayNameMin)
  .max(LIMITS.displayNameMax)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Use letters, numbers, spaces, _ . or -');

export const updateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  acceptTerms: z.literal(true).optional(),
});

export const REPORT_REASONS = ['vandalism', 'harassment', 'personal-info', 'spam', 'copyright', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_TARGETS = ['story', 'revision', 'user', 'development', 'correction', 'collection'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const createReportSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(LIMITS.reportDetailsMax).nullish(),
});

/** Asks for an upload slot; the exact size is signed into the upload URL. */
export const uploadIntentSchema = z.object({
  size: z.number().int().min(1).max(LIMITS.imageBytesMax, 'Images must be smaller than 6 MB.'),
});
