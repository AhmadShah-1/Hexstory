import { z } from 'zod';
import type { TrustLevel } from './types.js';

/**
 * The contribution rules people see on the About and account pages, shared so the numbers shown
 * are always the ones the API enforces. Other anti-abuse numbers live in apps/api/src/policy.ts.
 */
export const RULES = {
  /** Stories a user can create per 24h, by trust level. */
  storiesPerDay: { 0: 3, 1: 10, 2: 100, 3: 1000 } satisfies Record<TrustLevel, number>,
  /** Revisions (edits) a user can submit per 24h, by trust level. */
  editsPerDay: { 0: 10, 1: 20, 2: 300, 3: 5000 } satisfies Record<TrustLevel, number>,
  /**
   * Automatic promotion, counted in distinct *published* stories with an accepted contribution.
   * Reviewers must also have improved stories other people started, which can't be self-farmed.
   */
  promotion: {
    member: { minAgeDays: 3, minStories: 3, minOthersStories: 0 },
    reviewer: { minAgeDays: 30, minStories: 25, minOthersStories: 15 },
  },
  /** Accounts younger than this can read the Square but not post. */
  chatMinAccountMinutes: 10,
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

/**
 * The rules Moderators can change at runtime (Moderation → Settings). Stored as overrides of the
 * defaults above; see effectiveRules().
 */
export const editableRulesSchema = z
  .object({
    memberMinAgeDays: z.number().int().min(0).max(365),
    memberMinStories: z.number().int().min(0).max(1_000),
    reviewerMinAgeDays: z.number().int().min(0).max(3_650),
    reviewerMinStories: z.number().int().min(0).max(10_000),
    reviewerMinOthersStories: z.number().int().min(0).max(10_000),
    chatMinAccountMinutes: z.number().int().min(0).max(10_080),
  })
  .refine((r) => r.reviewerMinAgeDays >= r.memberMinAgeDays, {
    message: 'Reviewers need at least as many days as Members',
    path: ['reviewerMinAgeDays'],
  })
  .refine((r) => r.reviewerMinStories >= r.memberMinStories, {
    message: 'Reviewers need at least as many stories as Members',
    path: ['reviewerMinStories'],
  })
  .refine((r) => r.reviewerMinOthersStories <= r.reviewerMinStories, {
    message: "Can't be more than the stories Reviewers need in total",
    path: ['reviewerMinOthersStories'],
  });
export type EditableRules = z.infer<typeof editableRulesSchema>;

/** RULES with its numbers widened, so overrides fit. */
export type Rules = {
  [K in keyof typeof RULES]: (typeof RULES)[K] extends number
    ? number
    : (typeof RULES)[K] extends Record<TrustLevel, number>
      ? Record<TrustLevel, number>
      : { member: { minAgeDays: number; minStories: number; minOthersStories: number }; reviewer: { minAgeDays: number; minStories: number; minOthersStories: number } };
};

export function editableFrom(rules: Rules): EditableRules {
  return {
    memberMinAgeDays: rules.promotion.member.minAgeDays,
    memberMinStories: rules.promotion.member.minStories,
    reviewerMinAgeDays: rules.promotion.reviewer.minAgeDays,
    reviewerMinStories: rules.promotion.reviewer.minStories,
    reviewerMinOthersStories: rules.promotion.reviewer.minOthersStories,
    chatMinAccountMinutes: rules.chatMinAccountMinutes,
  };
}

/** The defaults with a Moderator's overrides applied. Unknown or invalid overrides are ignored. */
export function effectiveRules(overrides: unknown): Rules {
  const parsed = editableRulesSchema.safeParse({ ...editableFrom(RULES), ...(overrides && typeof overrides === 'object' ? overrides : {}) });
  const e = parsed.success ? parsed.data : editableFrom(RULES);
  return {
    ...RULES,
    promotion: {
      member: { minAgeDays: e.memberMinAgeDays, minStories: e.memberMinStories, minOthersStories: 0 },
      reviewer: { minAgeDays: e.reviewerMinAgeDays, minStories: e.reviewerMinStories, minOthersStories: e.reviewerMinOthersStories },
    },
    chatMinAccountMinutes: e.chatMinAccountMinutes,
  };
}
