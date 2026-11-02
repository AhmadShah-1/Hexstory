import { RULES, TRUST, type Rules, type TrustLevel } from '@hexstory/shared';

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
  correctionsPerDay: RULES.correctionsPerDay,
  collectionsPerDay: RULES.collectionsPerDay,
  largeRemovalRatio: RULES.largeRemovalPercent / 100,
  newcomerMaxLinks: RULES.newcomerMaxLinks,
  uploadsPerDay: RULES.uploadsPerDay,
  uploadMegabytesPerDay: RULES.uploadMegabytesPerDay,
  // Promotion thresholds can be changed by Moderators at runtime: read them with getRules()
  // (services/settings.ts), never from RULES directly.
  /** Random picks ("Surprise me") favour stories with at least this many sources. */
  surpriseMinSources: 2,
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

/** What promotion looks at: reputation (see REPUTATION in packages/shared/src/rules.ts) and breadth. */
export interface PromotionStanding {
  reputation: number;
  /** Published stories started by someone else that they improved or corrected. */
  others: number;
  /** Weeks in which something of theirs was accepted. */
  activeWeeks: number;
}

const meets = (ageDays: number, s: PromotionStanding, step: Rules['promotion']['member']) =>
  ageDays >= step.minAgeDays && s.reputation >= step.minReputation && s.others >= step.minOthers && s.activeWeeks >= step.minActiveWeeks;

/** Trust level earned automatically from history. Never demotes; moderators are set by ADMIN_EMAILS. */
export function earnedTrustLevel(current: number, ageDays: number, standing: PromotionStanding, promotion: Rules['promotion']): TrustLevel {
  if (current < TRUST.REVIEWER && meets(ageDays, standing, promotion.reviewer)) return TRUST.REVIEWER;
  if (current < TRUST.MEMBER && meets(ageDays, standing, promotion.member)) return TRUST.MEMBER;
  return current as TrustLevel;
}
