import type { DateParts } from './dates.js';
import type { Category, LinkRelation } from './history.js';
import type { RichDoc } from './richtext.js';
import type { CollectionKind, CorrectionProblem, Location, ReportReason, ReportTarget, Source } from './schemas.js';

/** Trust levels gate what a user can do; see docs/DESIGN.md "Trust & moderation". */
export const TRUST = {
  NEW: 0,
  MEMBER: 1,
  REVIEWER: 2,
  MODERATOR: 3,
} as const;
export type TrustLevel = (typeof TRUST)[keyof typeof TRUST];

export const TRUST_NAMES: Record<TrustLevel, string> = {
  0: 'Newcomer',
  1: 'Member',
  2: 'Reviewer',
  3: 'Moderator',
};

export interface Me {
  id: string;
  displayName: string;
  trustLevel: TrustLevel;
  termsAccepted: boolean;
  createdAt: string;
}

export interface SessionInfo {
  user: Me | null;
  signInEnabled: boolean;
}

export type StoryStatus = 'unreviewed' | 'active' | 'hidden';
export type RevisionStatus = 'pending' | 'accepted' | 'rejected';

export interface StorySummary {
  id: string;
  title: string;
  /** The concise summary (for stories written before summaries existed, the start of the text). */
  summary: string;
  thumbUrl: string | null;
  start: DateParts;
  end: DateParts | null;
  isOngoing: boolean;
  isApprox: boolean;
  categories: Category[];
  placeName: string | null;
  sourceCount: number;
  cellCount: number;
  status: StoryStatus;
  publishedAt: string | null;
  /** Latest accepted change or timeline development. */
  lastUpdateAt: string;
  /** An account of an older event, newly added (rather than an event written about as it happened). */
  isHistorical: boolean;
  /** Ongoing, or had a development recently (DEVELOPING_DAYS). */
  developing: boolean;
  featured: boolean;
}

/** A story as the map draws it: compact, so every published story fits in one cached response. */
export interface MapPoint {
  id: string;
  title: string;
  lat: number;
  lng: number;
  categories: Category[];
  /** eventRange() of the story: comparable date keys. */
  lo: number;
  hi: number;
  /** First year, for the period layer. */
  year: number;
  developing: boolean;
}

export interface StoryRevision {
  id: string;
  storyId: string;
  parentRevisionId: string | null;
  author: { id: string; displayName: string };
  title: string;
  /** Plain-text rendering of `content` (used for diffs). */
  body: string;
  /** The story itself; image blocks carry a `url`. */
  content: RichDoc;
  thumbUrl: string | null;
  /** Null for versions written before summaries existed. */
  summary: string | null;
  categories: Category[];
  /** Null for versions written before precise locations existed (the map then uses the area's centre). */
  location: Location | null;
  /** Optional wider area, compact H3 cells. Without one, the point's cell. */
  cells: string[];
  start: DateParts;
  end: DateParts | null;
  isOngoing: boolean;
  isApprox: boolean;
  sources: Source[];
  people: string[];
  links: { storyId: string; relation: LinkRelation }[];
  status: RevisionStatus;
  editSummary: string | null;
  flags: string[];
  /** Removed from the history by a reviewer or a ban clean-up: never restorable, visible to reviewers only. */
  removed: boolean;
  createdAt: string;
}

export interface StoryDetail {
  id: string;
  /** 'unreviewed' stories are visible only to their creator and reviewers until a reviewer approves them. */
  status: StoryStatus;
  protectionLevel: TrustLevel;
  createdAt: string;
  createdBy: { id: string; displayName: string };
  revision: StoryRevision;
  cellCount: number;
  pendingCount: number;
  /** Where the map puts it: the version's point, or the centre of its area for older stories. */
  point: { lat: number; lng: number };
  publishedAt: string | null;
  lastUpdateAt: string;
  featured: boolean;
  isHistorical: boolean;
  /** Links in both directions, from this story's point of view, to stories the viewer can see. */
  connections: StoryConnection[];
  /** Latest developments (newest first; the full feed is /api/stories/:id/developments). */
  developments: Development[];
  developmentCount: number;
  /** Corrections that are open, for the "disputed" notice; resolved ones are listed with the story too. */
  openCorrections: number;
  /** Place collections and hand-picked collections this story belongs to. */
  collections: CollectionRef[];
  /** What the current viewer may do; computed server-side so the UI never guesses. */
  can: { edit: boolean; editGoesLive: boolean; review: boolean; addDevelopment: boolean; correct: boolean; feature: boolean };
}

export interface StoryRef {
  id: string;
  title: string;
  start: DateParts;
  end: DateParts | null;
  isOngoing: boolean;
  isApprox: boolean;
  thumbUrl: string | null;
}

export interface StoryConnection {
  relation: LinkRelation;
  /** 'out': this story's current version names the link; 'in': the other story does. */
  direction: 'out' | 'in';
  story: StoryRef;
}

export interface Development {
  id: string;
  storyId: string;
  date: DateParts;
  title: string;
  body: string | null;
  location: Location | null;
  sources: Source[];
  status: RevisionStatus;
  removed: boolean;
  author: { id: string; displayName: string };
  createdAt: string;
}

export type CorrectionStatus = 'open' | 'accepted' | 'rejected';

export interface Correction {
  id: string;
  storyId: string;
  /** The version the reader disputed (it stays in the history whatever the outcome). */
  revisionId: string;
  quote: string;
  problem: CorrectionProblem;
  proposal: string;
  evidence: Source[];
  status: CorrectionStatus;
  /** Whether the quoted statement is still in the current version. */
  stillInStory: boolean;
  author: { id: string; displayName: string };
  createdAt: string;
  resolution: {
    note: string;
    by: { id: string; displayName: string };
    at: string;
    fixedRevisionId: string | null;
  } | null;
  removed: boolean;
}

export interface CollectionRef {
  id: string;
  title: string;
  kind: CollectionKind;
}

export interface CollectionSummary extends CollectionRef {
  description: string;
  storyCount: number;
  featured: boolean;
  /** Compact cells of the area (place collections). */
  cells: string[];
  createdBy: { id: string; displayName: string };
  updatedAt: string;
}

export interface CollectionDetail extends CollectionSummary {
  status: 'active' | 'hidden';
  categories: Category[];
  fromYear: number | null;
  toYear: number | null;
  /** Hand-picked stories in their arranged order, with the curator's note. */
  items: { story: StorySummary; note: string | null }[];
  /** Stories gathered by the collection's rules (area, categories, years), by date. Capped. */
  matched: StorySummary[];
  matchedTotal: number;
  can: { edit: boolean; hide: boolean; feature: boolean };
}

/** The guided-discovery home panel. */
export interface DiscoverData {
  featured: StorySummary[];
  /** Ongoing events and events with recent developments, most recently updated first. */
  developing: StorySummary[];
  /** Accounts of older events, newly added. */
  discoveries: StorySummary[];
  /** Events written about as they happened, newest first. */
  recent: StorySummary[];
  onThisDay: StorySummary[];
  collections: CollectionSummary[];
  /** How many published stories exist; lets the home page adapt while the site is young. */
  total: number;
}

export interface RevisionListItem {
  id: string;
  author: { id: string; displayName: string };
  status: RevisionStatus;
  editSummary: string | null;
  flags: string[];
  isCurrent: boolean;
  removed: boolean;
  createdAt: string;
}

/** Result of creating or editing a story. */
export interface WriteResult {
  storyId: string;
  revisionId: string;
  /** Whether this change became the story's current version ('pending' = held for review). */
  status: 'live' | 'pending';
  /** 'unreviewed' means the story itself is not public yet, even if this change is its current version. */
  storyStatus: StoryStatus;
}

export interface Report {
  id: string;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  reporter: { id: string; displayName: string };
  createdAt: string;
  /** Short human-readable description of what was reported, with a link target if any. */
  context: { label: string; storyId: string | null; collectionId: string | null };
}

export interface PendingRevision {
  revision: StoryRevision;
  currentRevision: StoryRevision | null;
}

/** A newcomer's story waiting for a reviewer to approve (publish) it. */
export interface UnreviewedStory {
  story: StorySummary;
  author: { id: string; displayName: string };
  /** The version on screen when approving; approval fails if the author changed it since. */
  revisionId: string;
  excerpt: string;
  createdAt: string;
}

export interface WatchtowerData {
  pending: PendingRevision[];
  unreviewed: UnreviewedStory[];
  reports: Report[];
  /** Developments held for review, with the story they belong to. */
  developments: (Development & { storyTitle: string })[];
  /** Open corrections, oldest first, with the story title. */
  corrections: (Correction & { storyTitle: string })[];
}

export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}

/** How someone's reputation adds up (points per REPUTATION). Shown to them and to reviewers only. */
export interface ReputationBreakdown {
  publishedStories: number;
  linkedSources: number;
  improvedStories: number;
  developments: number;
  correctionsAccepted: number;
  activeWeeks: number;
  correctionsRejected: number;
  editsRejected: number;
  correctedStories: number;
  removed: number;
}

/** Where someone stands against the automatic promotion rules (RULES.promotion). */
export interface TrustProgress {
  ageDays: number;
  reputation: number;
  breakdown: ReputationBreakdown;
  /** Published stories started by someone else that they improved or corrected. */
  others: number;
  activeWeeks: number;
  /** The next automatic level, or null if there is none (or a moderator fixed their level). */
  next: { level: TrustLevel; minAgeDays: number; minReputation: number; minOthers: number; minActiveWeeks: number } | null;
}

export interface UserStats {
  storiesStarted: number;
  storiesLive: number;
  /** Versions written (first versions and edits; not restore copies). */
  edits: number;
  editsAccepted: number;
  editsWaiting: number;
  editsRejected: number;
  editsRemoved: number;
  developments: number;
  corrections: number;
  correctionsAccepted: number;
}

export interface BanRequest {
  id: string;
  requestedBy: { id: string; displayName: string };
  reason: string;
  createdAt: string;
}

/**
 * A user's page. Everyone sees the top-level fields; `details` is for the user themself and for
 * reviewers/moderators; `moderation` is for reviewers/moderators only.
 */
export interface UserProfile {
  id: string;
  displayName: string;
  trustLevel: TrustLevel;
  createdAt: string;
  deleted: boolean;
  details: {
    stats: UserStats;
    progress: TrustProgress;
    /** Set when a moderator fixed their level; automatic promotion is paused. */
    trustLocked: boolean;
    today: {
      stories: number;
      storiesLimit: number;
      edits: number;
      editsLimit: number;
      uploads: number;
      uploadsLimit: number;
      uploadMegabytes: number;
      uploadMegabytesLimit: number;
    };
  } | null;
  moderation: {
    banned: { at: string; reason: string | null } | null;
    openReports: number;
    banRequests: BanRequest[];
  } | null;
}

/** A story someone started, as listed on their contributions page. */
export interface ContributionStory {
  story: StorySummary;
  /** live: public. waiting: not public until a reviewer approves it. rejected: its first version was turned down. */
  state: 'live' | 'waiting' | 'hidden' | 'rejected';
  createdAt: string;
}

/** One version someone wrote, as listed on their contributions page. */
export interface ContributionEdit {
  id: string;
  storyId: string;
  storyTitle: string;
  /** Whether the story itself is public ('active'), waiting for approval or hidden. */
  storyStatus: StoryStatus;
  /** The version started the story. */
  isFirst: boolean;
  status: RevisionStatus;
  isCurrent: boolean;
  removed: boolean;
  editSummary: string | null;
  flags: string[];
  createdAt: string;
}

/** A row in the moderators' user list. */
export interface ModUserRow {
  id: string;
  displayName: string;
  trustLevel: TrustLevel;
  trustLocked: boolean;
  createdAt: string;
  bannedAt: string | null;
  stories: number;
  edits: number;
  openReports: number;
  openBanRequests: number;
}

/** A user with open ban requests, as queued for moderators. */
export interface BanRequestGroup {
  user: ModUserRow;
  requests: BanRequest[];
}

/** What a ban or deletion with clean-up removed. */
export interface CleanupSummary {
  storiesHidden: number;
  storiesRolledBack: number;
  editsRejected: number;
  versionsRemoved: number;
  developmentsRemoved: number;
  correctionsRemoved: number;
  collectionsHidden: number;
  reportsClosed: number;
}

export interface AuditEntry {
  id: string;
  actor: { id: string; displayName: string };
  action: string;
  targetType: string;
  targetId: string;
  /** Description of the target for display, with ids to link to where they apply. */
  target: { label: string | null; storyId: string | null; userId: string | null; cell: string | null };
  reason: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** Where the browser uploads an image original before the server processes it. */
export interface UploadTicket {
  id: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}
export interface UploadedImage {
  imageKey: string;
  imageUrl: string;
  thumbUrl: string;
}

/** A place found by the search box, already resolved to the one hexagon to open for it. */
export interface Place {
  name: string;
  /** Where it is, e.g. "Hudson, New Jersey, United States". */
  detail: string;
  /** What it is, e.g. "City", "Country", "Lake". */
  kind: string;
  lat: number;
  lng: number;
  /** The display hexagon to open: the finest one for towns and cities, a larger one for regions and countries. */
  cell: string;
}
