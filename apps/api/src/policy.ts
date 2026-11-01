import { RULES, TRUST, type TrustLevel } from '@hexstory/shared';

/**
 * Anti-abuse policy in one place. Tune numbers here, or in `RULES` (packages/shared/src/rules.ts) for
 * the ones shown to users on the About page; the reasoning lives in docs/DESIGN.md.
 */
export const POLICY = {
  sessionDays: 30,
  storiesPerDay: RULES.storiesPerDay,
  editsPerDay: RULES.editsPerDay,
  /** API requests per client IP per minute, across all instances. */
  requestsPerMinute: 300,
  /** Upload slots a user can request per hour (completing allows twice this, for retries). */
  uploadsPerHour: 20,
  reportsPerDay: RULES.reportsPerDay,
  /** Socket.IO events (join/leave/send) one connection may emit per 10 seconds before being dropped. */
  socketEventsPer10s: 30,
  /** Minimum gap between chat messages from one user. */
  chatIntervalMs: 2_000,
  chatMinAccountAgeMs: RULES.chatMinAccountMinutes * 60 * 1000,
  largeRemovalRatio: RULES.largeRemovalPercent / 100,
  newcomerMaxLinks: RULES.newcomerMaxLinks,
  promotion: RULES.promotion,
  /** Chat messages from the last this-many hours are removed live from open Squares when their author is banned. */
  banLiveHideHours: 24,
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

/** The next level someone can earn automatically, or null. */
export function nextEarnedLevel(current: number): TrustLevel | null {
  if (current < TRUST.MEMBER) return TRUST.MEMBER;
  if (current < TRUST.REVIEWER) return TRUST.REVIEWER;
  return null;
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
