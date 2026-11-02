import { z } from 'zod';
import type { TrustLevel } from './types.js';

/**
 * Reputation points for each kind of contribution. Quality over quantity: what counts is work that
 * was accepted and held up (published stories with linked sources, improvements to other people's
 * stories, accepted corrections, steady participation over weeks), and what was turned down, removed
 * or corrected costs points. Repeatedly editing one story earns nothing extra. See docs/DESIGN.md §6.
 */
export const REPUTATION = {
  /** A story you started that is published. */
  publishedStory: 5,
  /** Each linked (URL) source on your published stories, up to `sourcesPerStoryMax` per story. */
  linkedSource: 1,
  sourcesPerStoryMax: 3,
  /** Each published story someone else started that you improved with an accepted edit (once per story). */
  improvedStory: 3,
  /** Each accepted development you added to an event's timeline, up to `developmentsPerStoryMax` per story. */
  development: 2,
  developmentsPerStoryMax: 5,
  /** Each of your corrections that a reviewer accepted. */
  correctionAccepted: 8,
  /** Each week in which something of yours was accepted, up to `activeWeeksMax`. */
  activeWeek: 1,
  activeWeeksMax: 52,
  /** Each of your corrections that a reviewer turned down. */
  correctionRejected: -2,
  /** Each of your edits or new stories that a reviewer turned down. */
  editRejected: -2,
  /** Each accepted correction to a story you started (it had an error). */
  correctedStory: -2,
  /** Each version or development of yours removed by reviewers, and each published story of yours hidden. */
  removed: -15,
} as const;

/**
 * The contribution rules people see on the About and account pages, shared so the numbers shown
 * are always the ones the API enforces. Other anti-abuse numbers live in apps/api/src/policy.ts.
 */
export const RULES = {
  /** Stories a user can create per 24h, by trust level. */
  storiesPerDay: { 0: 3, 1: 10, 2: 100, 3: 1000 } satisfies Record<TrustLevel, number>,
  /** Edits and timeline developments a user can submit per 24h, by trust level. */
  editsPerDay: { 0: 10, 1: 20, 2: 300, 3: 5000 } satisfies Record<TrustLevel, number>,
  /** Corrections a user can propose per 24h, by trust level. */
  correctionsPerDay: { 0: 5, 1: 20, 2: 100, 3: 1000 } satisfies Record<TrustLevel, number>,
  /** Collections a user can create per 24h, by trust level (Newcomers can't). */
  collectionsPerDay: { 0: 0, 1: 3, 2: 20, 3: 100 } satisfies Record<TrustLevel, number>,
  /**
   * Automatic promotion, by reputation (see REPUTATION). Reviewers must also have improved or corrected
   * stories other people started, over several weeks, which can't be self-farmed.
   */
  promotion: {
    member: { minAgeDays: 3, minReputation: 15, minOthers: 0, minActiveWeeks: 0 },
    reviewer: { minAgeDays: 30, minReputation: 150, minOthers: 10, minActiveWeeks: 4 },
  },
  /** An edit removing more than this share of the text is held for review. */
  largeRemovalPercent: 60,
  /** Newcomer edits with more links than this are held for review. */
  newcomerMaxLinks: 2,
  reportsPerDay: 30,
  /** Photo uploads a user can start per 24h, by trust level. */
  uploadsPerDay: { 0: 10, 1: 30, 2: 100, 3: 300 } satisfies Record<TrustLevel, number>,
  /** Total size of the originals a user can upload per 24h, in MB, by trust level. */
  uploadMegabytesPerDay: { 0: 20, 1: 80, 2: 250, 3: 1000 } satisfies Record<TrustLevel, number>,
} as const;

export type PromotionStep = { minAgeDays: number; minReputation: number; minOthers: number; minActiveWeeks: number };

/**
 * The rules Moderators can change at runtime (Moderation → Settings). Stored as overrides of the
 * defaults above; see effectiveRules().
 */
export const editableRulesSchema = z
  .object({
    memberMinAgeDays: z.number().int().min(0).max(365),
    memberMinReputation: z.number().int().min(0).max(10_000),
    reviewerMinAgeDays: z.number().int().min(0).max(3_650),
    reviewerMinReputation: z.number().int().min(0).max(100_000),
    reviewerMinOthers: z.number().int().min(0).max(10_000),
    reviewerMinActiveWeeks: z.number().int().min(0).max(520),
  })
  .refine((r) => r.reviewerMinAgeDays >= r.memberMinAgeDays, {
    message: 'Reviewers need at least as many days as Members',
    path: ['reviewerMinAgeDays'],
  })
  .refine((r) => r.reviewerMinReputation >= r.memberMinReputation, {
    message: 'Reviewers need at least as much reputation as Members',
    path: ['reviewerMinReputation'],
  });
export type EditableRules = z.infer<typeof editableRulesSchema>;

/** RULES with its numbers widened, so overrides fit. */
export type Rules = {
  [K in keyof typeof RULES]: (typeof RULES)[K] extends number
    ? number
    : (typeof RULES)[K] extends Record<TrustLevel, number>
      ? Record<TrustLevel, number>
      : { member: PromotionStep; reviewer: PromotionStep };
};

export function editableFrom(rules: Rules): EditableRules {
  return {
    memberMinAgeDays: rules.promotion.member.minAgeDays,
    memberMinReputation: rules.promotion.member.minReputation,
    reviewerMinAgeDays: rules.promotion.reviewer.minAgeDays,
    reviewerMinReputation: rules.promotion.reviewer.minReputation,
    reviewerMinOthers: rules.promotion.reviewer.minOthers,
    reviewerMinActiveWeeks: rules.promotion.reviewer.minActiveWeeks,
  };
}

/**
 * The defaults with a Moderator's overrides applied. Unknown or invalid overrides are ignored
 * (including those for rules that no longer exist, such as the old story-count thresholds).
 */
export function effectiveRules(overrides: unknown): Rules {
  const parsed = editableRulesSchema.safeParse({ ...editableFrom(RULES), ...(overrides && typeof overrides === 'object' ? overrides : {}) });
  const e = parsed.success ? parsed.data : editableFrom(RULES);
  return {
    ...RULES,
    promotion: {
      member: { minAgeDays: e.memberMinAgeDays, minReputation: e.memberMinReputation, minOthers: 0, minActiveWeeks: 0 },
      reviewer: {
        minAgeDays: e.reviewerMinAgeDays,
        minReputation: e.reviewerMinReputation,
        minOthers: e.reviewerMinOthers,
        minActiveWeeks: e.reviewerMinActiveWeeks,
      },
    },
  };
}
