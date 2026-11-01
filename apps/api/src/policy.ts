import { TRUST, type TrustLevel } from '@hexstory/shared';

/**
 * Anti-abuse policy in one place. Tune numbers here; the reasoning lives in docs/DESIGN.md.
 */
export const POLICY = {
  sessionDays: 30,
  /** Stories a user can create per 24h, by trust level. */
  storiesPerDay: { 0: 3, 1: 20, 2: 100, 3: 1000 } satisfies Record<TrustLevel, number>,
  /** Revisions (edits) a user can submit per 24h, by trust level. */
  editsPerDay: { 0: 10, 1: 60, 2: 300, 3: 5000 } satisfies Record<TrustLevel, number>,
  uploadsPerHour: 20,
  reportsPerDay: 30,
  /** Socket.IO events (join/leave/send) one connection may emit per 10 seconds before being dropped. */
  socketEventsPer10s: 30,
  /** Minimum gap between chat messages from one user. */
  chatIntervalMs: 2_000,
  /** Accounts younger than this can read the Square but not post. */
  chatMinAccountAgeMs: 10 * 60 * 1000,
  /** An edit removing more than this share of the body is held for review. */
  largeRemovalRatio: 0.6,
  /** Newcomer edits with more links than this are held for review. */
  newcomerMaxLinks: 2,
  /**
   * Automatic promotion, counted in distinct stories with an accepted contribution.
   * Reviewers must also have improved stories other people started, which can't be self-farmed.
   */
  promotion: {
    member: { minAgeDays: 3, minStories: 3 },
    reviewer: { minAgeDays: 30, minStories: 25, minOthersStories: 15 },
  },
} as const;

export interface Actor {
  id: string;
  trustLevel: TrustLevel;
  createdAt: Date;
}

/** Trust level an actor needs for an edit to a story to go live without review. */
export function liveEditThreshold(protectionLevel: number): number {
  return Math.max(TRUST.MEMBER, protectionLevel);
}

export function canReview(trustLevel: number): boolean {
  return trustLevel >= TRUST.REVIEWER;
}

/** Automatic red flags on an edit. Any flag holds the edit for review unless the author is a reviewer. */
export function detectFlags(params: { previousBody: string | null; body: string; links: number; trustLevel: number }): string[] {
  const flags: string[] = [];
  const { previousBody, body, trustLevel } = params;
  if (previousBody && body.length < previousBody.length * (1 - POLICY.largeRemovalRatio)) {
    flags.push('large-removal');
  }
  // Linked text plus any bare URLs typed into the text.
  const links = params.links + (body.match(/https?:\/\//g)?.length ?? 0);
  if (trustLevel < TRUST.MEMBER && links > POLICY.newcomerMaxLinks) flags.push('many-links');
  return flags;
}

/** Trust level earned automatically from history. Never demotes; moderators are set by ADMIN_EMAILS. */
export function earnedTrustLevel(
  current: number,
  ageDays: number,
  contributions: { stories: number; othersStories: number },
): TrustLevel {
  const { member, reviewer } = POLICY.promotion;
  let level: number = current;
  if (
    level < TRUST.REVIEWER &&
    ageDays >= reviewer.minAgeDays &&
    contributions.stories >= reviewer.minStories &&
    contributions.othersStories >= reviewer.minOthersStories
  ) {
    level = TRUST.REVIEWER;
  } else if (level < TRUST.MEMBER && ageDays >= member.minAgeDays && contributions.stories >= member.minStories) {
    level = TRUST.MEMBER;
  }
  return level as TrustLevel;
}
