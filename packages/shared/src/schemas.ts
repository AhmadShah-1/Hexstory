import { z } from 'zod';
import { compareDateParts, daysInMonth } from './dates.js';
import { isDisplayCell } from './hex.js';
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

const storyFields = z.object({
  title: trimmed(LIMITS.titleMin, LIMITS.titleMax, `Give it a title of at least ${LIMITS.titleMin} characters`),
  content: richDocSchema,
  cells: z
    .array(z.string().refine(isDisplayCell, 'Invalid region'))
    .min(1, 'Pick at least one region on the map')
    .max(LIMITS.cellsMax, 'That area is too large. Pick fewer or smaller regions'),
  start: datePartsSchema,
  end: datePartsSchema.nullish(),
  isOngoing: z.boolean().default(false),
  isApprox: z.boolean().default(false),
  sources: z
    .array(sourceSchema)
    .min(LIMITS.sourcesMin, 'Add at least one source')
    .max(LIMITS.sourcesMax, `At most ${LIMITS.sourcesMax} sources`),
});

const withDateRules = <T extends z.ZodType<z.infer<typeof storyFields>>>(schema: T) =>
  schema
    .refine((s) => !(s.isOngoing && s.end), { message: 'An ongoing event has no end date', path: ['end'] })
    .refine((s) => !s.end || compareDateParts(s.end, s.start) >= 0, {
      message: 'End date is before the start date',
      path: ['end'],
    });

export const createStorySchema = withDateRules(storyFields);
export type CreateStoryInput = z.infer<typeof createStorySchema>;

export const editStorySchema = withDateRules(
  storyFields.extend({
    baseRevisionId: z.uuid(),
    editSummary: z.string().trim().max(LIMITS.editSummaryMax).nullish(),
  }),
);
export type EditStoryInput = z.infer<typeof editStorySchema>;

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

export const REPORT_TARGETS = ['story', 'revision', 'comment', 'user'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];

export const createReportSchema = z.object({
  targetType: z.enum(REPORT_TARGETS),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(LIMITS.reportDetailsMax).nullish(),
});

export const chatMessageSchema = z.object({
  cell: z.string().refine(isDisplayCell),
  body: trimmed(1, LIMITS.chatMessageMax),
});
