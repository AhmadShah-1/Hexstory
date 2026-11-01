import type { DateParts } from './dates.js';
import type { RichDoc } from './richtext.js';
import type { ReportReason, ReportTarget, Source } from './schemas.js';

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

export interface CellCount {
  cell: string;
  count: number;
}

export type StoryStatus = 'unreviewed' | 'active' | 'hidden';
export type RevisionStatus = 'pending' | 'accepted' | 'rejected';

export interface StorySummary {
  id: string;
  title: string;
  thumbUrl: string | null;
  start: DateParts;
  end: DateParts | null;
  isOngoing: boolean;
  isApprox: boolean;
  sourceCount: number;
  cellCount: number;
  status: StoryStatus;
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
  cells: string[];
  start: DateParts;
  end: DateParts | null;
  isOngoing: boolean;
  isApprox: boolean;
  sources: Source[];
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
  /** What the current viewer may do; computed server-side so the UI never guesses. */
  can: { edit: boolean; editGoesLive: boolean; review: boolean };
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

export interface ChatMessage {
  id: string;
  cell: string;
  author: { id: string; displayName: string };
  body: string;
  createdAt: string;
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
  context: { label: string; storyId: string | null; cell: string | null };
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
}

export interface Page<T> {
  items: T[];
  nextOffset: number | null;
}

/** Where someone stands against the automatic promotion rules (RULES.promotion). */
export interface TrustProgress {
  ageDays: number;
  /** Distinct published stories with an accepted contribution of theirs. */
  stories: number;
  /** ...of which someone else started. */
  othersStories: number;
  /** The next automatic level, or null if there is none (or a moderator fixed their level). */
  next: { level: TrustLevel; minAgeDays: number; minStories: number; minOthersStories: number } | null;
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
  messages: number;
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
  messagesHidden: number;
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

/** Events sent over the Square (Socket.IO) connection. */
export interface ServerToClientEvents {
  message: (msg: ChatMessage) => void;
  presence: (data: { cell: string; count: number }) => void;
  hidden: (data: { id: string }) => void;
  /** The server may have missed live events (its Redis link dropped); clients should refetch history. */
  resync: () => void;
}
export interface ClientToServerEvents {
  /** The ack fires once the socket is in the room, so history fetched afterwards can't miss a message. */
  join: (cell: string, ack?: () => void) => void;
  leave: (cell: string) => void;
  send: (data: { cell: string; body: string }, ack: (res: SendResult) => void) => void;
}
/** `delayed`: the message was saved but could not be relayed live to other servers. */
export type SendResult = { ok: true; delayed?: boolean } | { ok: false; error: string };

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
