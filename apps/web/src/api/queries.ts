import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RULES, type EditableRules, type Rules } from '@hexstory/shared';
import type {
  AuditEntry,
  BanRequestGroup,
  CellCount,
  ChatMessage,
  CleanupSummary,
  ContributionEdit,
  ContributionStory,
  CreateStoryInput,
  EditStoryInput,
  ModUserRow,
  Page,
  ReportReason,
  ReportTarget,
  RevisionListItem,
  SessionInfo,
  StoryDetail,
  StoryRevision,
  StorySummary,
  SupportLinks,
  UploadTicket,
  UploadedImage,
  UserProfile,
  WatchtowerData,
  WriteResult,
} from '@hexstory/shared';
import { ApiError, api } from './client';

/** All query keys in one place so invalidation stays consistent. */
export const keys = {
  session: ['session'] as const,
  support: ['support'] as const,
  cells: (res: number) => ['cells', res] as const,
  cellStories: (cell: string) => ['cell-stories', cell] as const,
  story: (id: string) => ['story', id] as const,
  revisions: (id: string) => ['revisions', id] as const,
  revision: (id: string) => ['revision', id] as const,
  messages: (cell: string) => ['messages', cell] as const,
  watchtower: ['watchtower'] as const,
  user: (id: string) => ['user', id] as const,
  userStories: (id: string) => ['user-stories', id] as const,
  userRevisions: (id: string) => ['user-revisions', id] as const,
  modUsers: (filters: ModUserFilters) => ['mod-users', filters] as const,
  banRequests: ['ban-requests'] as const,
  auditLog: (filters: AuditFilters) => ['audit-log', filters] as const,
};

export type ModUserFilters = { q?: string; level?: 0 | 1 | 2 | 3; filter?: 'all' | 'banned' | 'requested' | 'reported' };
export type AuditFilters = { actorId?: string; targetType?: 'story' | 'revision' | 'comment' | 'user' | 'report'; targetId?: string; action?: string };

/** `?a=1&b=x` from the defined values only. */
function queryString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '');
  return new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

/** Support page links (public config). Rarely changes, so it is fetched once per visit. */
export const useSupportLinks = () =>
  useQuery({ queryKey: keys.support, queryFn: () => api<SupportLinks>('/api/support'), staleTime: Infinity });

export const useSession = () =>
  useQuery({ queryKey: keys.session, queryFn: () => api<SessionInfo>('/api/session'), staleTime: 60_000 });

export const useCellCounts = (res: number) =>
  useQuery({
    queryKey: keys.cells(res),
    queryFn: () => api<CellCount[]>(`/api/cells?res=${res}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

export const useCellStories = (cell: string) =>
  useInfiniteQuery({
    queryKey: keys.cellStories(cell),
    queryFn: ({ pageParam }) =>
      api<{ items: StorySummary[]; nextOffset: number | null }>(`/api/cells/${cell}/stories?offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });

export const useStory = (id: string | undefined) =>
  useQuery({ queryKey: keys.story(id ?? ''), queryFn: () => api<StoryDetail>(`/api/stories/${id}`), enabled: !!id });

export const useRevisions = (storyId: string) =>
  useQuery({ queryKey: keys.revisions(storyId), queryFn: () => api<RevisionListItem[]>(`/api/stories/${storyId}/revisions`) });

export const useRevision = (id: string | null | undefined) =>
  useQuery({
    queryKey: keys.revision(id ?? ''),
    queryFn: () => api<StoryRevision>(`/api/revisions/${id}`),
    enabled: !!id,
    staleTime: Infinity, // revisions never change
  });

export const useMessages = (cell: string) =>
  useQuery({ queryKey: keys.messages(cell), queryFn: () => api<ChatMessage[]>(`/api/cells/${cell}/messages`) });

export const useWatchtower = (enabled: boolean) =>
  useQuery({ queryKey: keys.watchtower, queryFn: () => api<WatchtowerData>('/api/watchtower'), enabled });

/** After any write that can change what the map shows, refresh map + lists + the story itself. */
function useInvalidateStories() {
  const qc = useQueryClient();
  return (storyId?: string) => {
    qc.invalidateQueries({ queryKey: ['cells'] });
    qc.invalidateQueries({ queryKey: ['cell-stories'] });
    qc.invalidateQueries({ queryKey: keys.watchtower });
    qc.invalidateQueries({ queryKey: ['user-stories'] });
    qc.invalidateQueries({ queryKey: ['user-revisions'] });
    qc.invalidateQueries({ queryKey: ['user'] });
    qc.invalidateQueries({ queryKey: ['audit-log'] });
    if (storyId) {
      qc.invalidateQueries({ queryKey: keys.story(storyId) });
      qc.invalidateQueries({ queryKey: keys.revisions(storyId) });
    }
  };
}

export function useCreateStory() {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: CreateStoryInput) => api<WriteResult>('/api/stories', { method: 'POST', body: input }),
    onSuccess: (res) => invalidate(res.storyId),
  });
}

export function useEditStory(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: EditStoryInput) => api<WriteResult>(`/api/stories/${storyId}`, { method: 'PUT', body: input }),
    onSuccess: () => invalidate(storyId),
  });
}

export function useReviewRevision(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: ({ revisionId, decision }: { revisionId: string; decision: 'accept' | 'reject' }) =>
      api(`/api/revisions/${revisionId}/review`, { method: 'POST', body: { decision } }),
    onSuccess: () => invalidate(storyId),
  });
}

export function useRestoreRevision(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (revisionId: string) => api<WriteResult>(`/api/stories/${storyId}/restore`, { method: 'POST', body: { revisionId } }),
    onSuccess: () => invalidate(storyId),
  });
}

/**
 * Approve (status 'active' on a story waiting for review: pass the `revisionId` you showed the reviewer,
 * so approval fails if the author changed it since), hide, or (moderators) unhide a story.
 */
export function useSetStoryStatus(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: { status: 'active' | 'hidden'; revisionId?: string; reason?: string }) =>
      api(`/api/stories/${storyId}/status`, { method: 'POST', body: input }),
    onSuccess: () => invalidate(storyId),
  });
}

/** Remove a version from the history (reviewers), or put it back (moderators). Not allowed on the current version. */
export function useSetRevisionRemoved(storyId: string) {
  const invalidate = useInvalidateStories();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ revisionId, removed, reason }: { revisionId: string; removed: boolean; reason?: string }) =>
      api(`/api/revisions/${revisionId}/removed`, { method: 'POST', body: { removed, reason } }),
    onSuccess: (_res, { revisionId }) => {
      invalidate(storyId);
      qc.invalidateQueries({ queryKey: keys.revision(revisionId) });
    },
  });
}

export function useSetProtection(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (level: 0 | 1 | 2 | 3) => api(`/api/stories/${storyId}/protection`, { method: 'POST', body: { level } }),
    onSuccess: () => invalidate(storyId),
  });
}

export function useReport() {
  return useMutation({
    mutationFn: (input: { targetType: ReportTarget; targetId: string; reason: ReportReason; details?: string }) =>
      api('/api/reports', { method: 'POST', body: input }),
  });
}

export function useResolveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: 'dismissed' | 'actioned' }) =>
      api(`/api/reports/${id}/resolve`, { method: 'POST', body: { resolution } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.watchtower }),
  });
}

export function useHideMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/api/messages/${id}/hide`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.watchtower }),
  });
}

// ---- User pages & contributions ----

export const useUserProfile = (id: string | undefined) =>
  useQuery({ queryKey: keys.user(id ?? ''), queryFn: () => api<UserProfile>(`/api/users/${id}`), enabled: !!id });

/** Stories someone started. Only works for the user themself and reviewers. */
export const useUserStories = (id: string, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.userStories(id),
    queryFn: ({ pageParam }) => api<Page<ContributionStory>>(`/api/users/${id}/stories?offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
  });

/** Every version someone wrote. Only works for the user themself and reviewers. */
export const useUserRevisions = (id: string, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.userRevisions(id),
    queryFn: ({ pageParam }) => api<Page<ContributionEdit>>(`/api/users/${id}/revisions?offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
  });

// ---- Moderation (moderators, except requesting a ban: reviewers) ----

export const useModUsers = (filters: ModUserFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.modUsers(filters),
    queryFn: ({ pageParam }) =>
      api<Page<ModUserRow>>(`/api/moderation/users?${queryString({ ...filters, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
    placeholderData: (prev) => prev,
  });

export const useBanRequests = (enabled = true) =>
  useQuery({ queryKey: keys.banRequests, queryFn: () => api<BanRequestGroup[]>('/api/moderation/ban-requests'), enabled });

export const useAuditLog = (filters: AuditFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.auditLog(filters),
    queryFn: ({ pageParam }) => api<Page<AuditEntry>>(`/api/moderation/log?${queryString({ ...filters, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
  });

/** Everything a moderation action can change: the person, the queues, the log, and (after a clean-up) stories. */
function useInvalidateModeration() {
  const qc = useQueryClient();
  const invalidateStories = useInvalidateStories();
  return () => {
    for (const key of ['user', 'mod-users', 'ban-requests', 'audit-log', 'messages']) qc.invalidateQueries({ queryKey: [key] });
    qc.invalidateQueries({ queryKey: ['story'] });
    invalidateStories();
  };
}

export function useRequestBan(userId: string) {
  const invalidate = useInvalidateModeration();
  return useMutation({
    mutationFn: (reason: string) => api(`/api/users/${userId}/ban-requests`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

export function useDeclineBanRequests(userId: string) {
  const invalidate = useInvalidateModeration();
  return useMutation({
    mutationFn: (reason?: string) => api(`/api/users/${userId}/ban-requests/decline`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

/** Ban (optionally taking down everything they contributed) or unban. */
export function useBanUser(userId: string) {
  const invalidate = useInvalidateModeration();
  return useMutation({
    mutationFn: (input: { banned: boolean; reason?: string; removeContent?: boolean }) =>
      api<{ ok: true; cleanup: CleanupSummary | null }>(`/api/users/${userId}/ban`, { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

/** Delete (anonymise) an account, optionally taking down everything they contributed. */
export function useDeleteUser(userId: string) {
  const invalidate = useInvalidateModeration();
  return useMutation({
    mutationFn: (input: { reason?: string; removeContent: boolean }) =>
      api<{ ok: true; cleanup: CleanupSummary | null }>(`/api/users/${userId}/delete`, { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

/** Set a level by hand (0–2; pauses automatic promotion) or hand it back to the automatic rules. */
export function useSetTrust(userId: string) {
  const invalidate = useInvalidateModeration();
  return useMutation({
    mutationFn: (input: { level: 0 | 1 | 2 | 'auto'; reason?: string }) =>
      api(`/api/users/${userId}/trust`, { method: 'POST', body: input }),
    onSuccess: invalidate,
  });
}

// ---- Site rules (Moderators can change some of them) ----

/** The rules in force. Starts from the defaults compiled in, so pages never wait on it. */
export const useRules = () =>
  useQuery({ queryKey: ['rules'], queryFn: () => api<Rules>('/api/rules'), staleTime: 5 * 60_000, placeholderData: RULES as Rules });

type ModSettings = { rules: EditableRules; updated: { at: string; by: { id: string; displayName: string } } | null };

export const useModSettings = (enabled = true) =>
  useQuery({ queryKey: ['mod-settings'], queryFn: () => api<ModSettings>('/api/moderation/settings'), enabled });

export function useUpdateModSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rules: EditableRules; reason?: string }) => api<ModSettings>('/api/moderation/settings', { method: 'PUT', body: input }),
    onSuccess: (data) => {
      qc.setQueryData(['mod-settings'], data);
      for (const key of ['rules', 'audit-log', 'user']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

// ---- Your account ----

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName?: string; acceptTerms?: true }) => api('/api/me', { method: 'PATCH', body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.session });
      qc.invalidateQueries({ queryKey: ['user'] });
    },
  });
}

export function useSignOut() {
  return useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', body: {} }),
    onSuccess: () => window.location.assign('/'),
  });
}

export function useDeleteAccount() {
  return useMutation({
    mutationFn: () => api('/api/me', { method: 'DELETE' }),
    onSuccess: () => window.location.assign('/'),
  });
}

/**
 * Uploads go straight from the browser to private staging storage (a pre-signed R2 URL in
 * production, the API itself locally), then the API validates and publishes the image.
 */
export async function uploadImage(file: File): Promise<UploadedImage> {
  const ticket = await api<UploadTicket>('/api/uploads', { method: 'POST', body: { size: file.size } });
  let res: Response;
  try {
    res = await fetch(ticket.upload.url, {
      method: ticket.upload.method,
      headers: ticket.upload.headers,
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'The upload did not go through. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError(res.status, 'upload', 'The upload did not go through. Please try again.');
  return api<UploadedImage>(`/api/uploads/${ticket.id}/complete`, { method: 'POST', body: {} });
}

export const signInUrl = (returnTo: string) => `/auth/google?returnTo=${encodeURIComponent(returnTo)}`;

// ---- Resource usage (moderators) ----

type UsageReport = import('@hexstory/shared').UsageReport;
const usageKey = ['usage'] as const;

/** Hosting usage. The server caches provider readings (about 15 min), so this never polls. */
export const useUsage = (enabled = true) =>
  useQuery({
    queryKey: usageKey,
    queryFn: () => api<UsageReport>('/api/moderation/usage'),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

/** Asks every provider again now; the server allows this once a minute (429 otherwise). */
export function useRefreshUsage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UsageReport>('/api/moderation/usage/refresh', { method: 'POST', body: {} }),
    onSuccess: (report) => qc.setQueryData(usageKey, report),
  });
}
