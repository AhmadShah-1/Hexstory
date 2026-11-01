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
} as const;
