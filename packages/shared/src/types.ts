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
  createdAt: string;
}

export interface StoryDetail {
  id: string;
  status: StoryStatus;
  protectionLevel: TrustLevel;
  createdAt: string;
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
  createdAt: string;
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

export interface WatchtowerData {
  pending: PendingRevision[];
  unreviewed: StorySummary[];
  reports: Report[];
}

/** Events sent over the Square (Socket.IO) connection. */
export interface ServerToClientEvents {
  message: (msg: ChatMessage) => void;
  presence: (data: { cell: string; count: number }) => void;
  hidden: (data: { id: string }) => void;
}
export interface ClientToServerEvents {
  join: (cell: string) => void;
  leave: (cell: string) => void;
  send: (data: { cell: string; body: string }, ack: (res: { ok: true } | { ok: false; error: string }) => void) => void;
}
