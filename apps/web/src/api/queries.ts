import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RULES, type EditableRules, type Rules } from '@hexstory/shared';
import type {
  AuditEntry,
  BanRequestGroup,
  CleanupSummary,
  CollectionDetail,
  CollectionInput,
  CollectionKind,
  CollectionSummary,
  Correction,
  CreateCorrectionInput,
  CreateDevelopmentInput,
  Development,
  DiscoverData,
  MapPoint,
  Category,
  StoryKind,
  StorySort,
  ContributionEdit,
  ContributionStory,
  CreateStoryInput,
  EditStoryInput,
  ModUserRow,
  Page,
  Place,
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

/** Filters and ordering for story lists (sent as query parameters; see storyListQuerySchema). */
export interface StoryFilters {
  sort?: StorySort;
  kind?: StoryKind;
  categories?: Category[];
  from?: number;
  to?: number;
  q?: string;
  person?: string;
  /** Only ongoing events and those with recent developments. */
  ongoing?: '1';
  /** "On this day": "MM-DD". */
  on?: string;
}

/** All query keys in one place so invalidation stays consistent. */
export const keys = {
  session: ['session'] as const,
  support: ['support'] as const,
  mapPoints: ['map-points'] as const,
  discover: ['discover'] as const,
  stories: (filters: StoryFilters) => ['stories', filters] as const,
  summaries: (ids: string[]) => ['summaries', ids] as const,
  cellStories: (cell: string, filters: StoryFilters = {}) => ['cell-stories', cell, filters] as const,
  developments: (storyId: string) => ['developments', storyId] as const,
  corrections: (storyId: string) => ['corrections', storyId] as const,
  collections: (kind?: CollectionKind) => ['collections', kind ?? 'all'] as const,
  collection: (id: string) => ['collection', id] as const,
  story: (id: string) => ['story', id] as const,
  revisions: (id: string) => ['revisions', id] as const,
  revision: (id: string) => ['revision', id] as const,
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

/** List filters as query-string values (categories comma-separated). */
const listParams = (f: StoryFilters, offset: number) =>
  queryString({
    sort: f.sort,
    kind: f.kind && f.kind !== 'all' ? f.kind : undefined,
    categories: f.categories?.length ? f.categories.join(',') : undefined,
    from: f.from ?? undefined,
    to: f.to ?? undefined,
    q: f.q,
    person: f.person,
    ongoing: f.ongoing,
    on: f.on,
    offset,
  });

/** Every published story as a map point. The map filters, colours and counts these in the browser. */
export const useMapPoints = () =>
  useQuery({ queryKey: keys.mapPoints, queryFn: () => api<MapPoint[]>('/api/map/points'), staleTime: 60_000, placeholderData: (prev) => prev });

/** The guided-discovery home panel; "On this day" uses the visitor's own date. */
export const useDiscover = () => {
  const now = new Date();
  return useQuery({
    queryKey: [...keys.discover, now.getMonth() + 1, now.getDate()],
    queryFn: () => api<DiscoverData>(`/api/discover?m=${now.getMonth() + 1}&d=${now.getDate()}`),
    staleTime: 60_000,
  });
};

/** Any list of stories (explore, search, a person, developing events), paged. */
export const useStoryList = (filters: StoryFilters, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.stories(filters),
    queryFn: ({ pageParam }) => api<Page<StorySummary>>(`/api/stories?${listParams(filters, pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
    placeholderData: (prev) => prev,
  });

/** Stories in a region, with the same filters and orderings. */
export const useCellStories = (cell: string, filters: StoryFilters = {}) =>
  useInfiniteQuery({
    queryKey: keys.cellStories(cell, filters),
    queryFn: ({ pageParam }) => api<Page<StorySummary>>(`/api/cells/${cell}/stories?${listParams(filters, pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    placeholderData: (prev) => prev,
  });

/** Summaries for stories known by id (e.g. the nearest map points), in the given order. */
export const useStorySummaries = (ids: string[]) =>
  useQuery({
    queryKey: keys.summaries(ids),
    queryFn: () => api<StorySummary[]>(`/api/stories/summaries?ids=${ids.join(',')}`),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });

/** A random published story's id ("Surprise me" prefers well-sourced, connected ones). */
export const randomStoryId = async (mode: 'surprise' | 'any') => (await api<{ id: string | null }>(`/api/stories/random?mode=${mode}`)).id;

export const useStory = (id: string | undefined) =>
  useQuery({ queryKey: keys.story(id ?? ''), queryFn: () => api<StoryDetail>(`/api/stories/${id}`), enabled: !!id });

export const useRevisions = (storyId: string) =>
  useQuery({ queryKey: keys.revisions(storyId), queryFn: () => api<RevisionListItem[]>(`/api/stories/${storyId}/revisions`) });

export const useRevision = (id: string | null | undefined) =>
  useQuery({
    queryKey: keys.revision(id ?? ''),
    queryFn: () => api<StoryRevision>(`/api/revisions/${id}`),
    enabled: !!id,
    // A version's content never changes, but its status (reviewed, removed) does; writes invalidate it.
    staleTime: 60_000,
  });

export const useWatchtower = (enabled: boolean) =>
  useQuery({ queryKey: keys.watchtower, queryFn: () => api<WatchtowerData>('/api/watchtower'), enabled });

/** After any write that can change what the map shows, refresh map + lists + the story itself. */
function useInvalidateStories() {
  const qc = useQueryClient();
  return (storyId?: string) => {
    for (const key of ['map-points', 'discover', 'stories', 'summaries', 'cell-stories', 'collection', 'collections']) qc.invalidateQueries({ queryKey: [key] });
    qc.invalidateQueries({ queryKey: keys.watchtower });
    qc.invalidateQueries({ queryKey: ['user-stories'] });
    qc.invalidateQueries({ queryKey: ['user-revisions'] });
    qc.invalidateQueries({ queryKey: ['user'] });
    qc.invalidateQueries({ queryKey: ['audit-log'] });
    qc.invalidateQueries({ queryKey: ['revision'] });
    // Approvals and accepted edits can promote someone; the top bar and account page follow the session.
    qc.invalidateQueries({ queryKey: keys.session });
    if (storyId) {
      qc.invalidateQueries({ queryKey: keys.story(storyId) });
      qc.invalidateQueries({ queryKey: keys.revisions(storyId) });
      qc.invalidateQueries({ queryKey: keys.developments(storyId) });
      qc.invalidateQueries({ queryKey: keys.corrections(storyId) });
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
    /** `baseRevisionId`: the version current when the reviewer chose to restore (guards against double clicks). */
    mutationFn: ({ revisionId, baseRevisionId }: { revisionId: string; baseRevisionId?: string }) =>
      api<WriteResult>(`/api/stories/${storyId}/restore`, { method: 'POST', body: { revisionId, baseRevisionId } }),
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
      api<{ ok: true; status: 'active' | 'hidden' | 'unreviewed' }>(`/api/stories/${storyId}/status`, { method: 'POST', body: input }),
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

/** Report counts appear on people's pages, the Users list and the Watchtower. */
const REPORT_KEYS = [keys.watchtower, ['user'], ['mod-users'], ['audit-log']] as const;

export function useReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { targetType: ReportTarget; targetId: string; reason: ReportReason; details?: string }) =>
      api('/api/reports', { method: 'POST', body: input }),
    onSuccess: () => REPORT_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey })),
  });
}

export function useResolveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: 'dismissed' | 'actioned' }) =>
      api(`/api/reports/${id}/resolve`, { method: 'POST', body: { resolution } }),
    onSuccess: () => REPORT_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey })),
  });
}

/** Reviewers feature a story on the home page, or take it off. */
export function useSetFeatured(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (featured: boolean) => api(`/api/stories/${storyId}/featured`, { method: 'POST', body: { featured } }),
    onSuccess: () => invalidate(storyId),
  });
}

// ---- Event timelines ----

export const useDevelopments = (storyId: string, enabled = true) =>
  useInfiniteQuery({
    queryKey: keys.developments(storyId),
    queryFn: ({ pageParam }) => api<Page<Development>>(`/api/stories/${storyId}/developments?offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
  });

export function useAddDevelopment(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: CreateDevelopmentInput) =>
      api<{ id: string; status: 'live' | 'pending' }>(`/api/stories/${storyId}/developments`, { method: 'POST', body: input }),
    onSuccess: () => invalidate(storyId),
  });
}

/** Accept or turn down a held development (reviewers), or remove one from the timeline. */
export function useModerateDevelopment(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'accept' | 'reject' | 'remove'; reason?: string }) =>
      action === 'remove'
        ? api(`/api/developments/${id}/remove`, { method: 'POST', body: { reason } })
        : api(`/api/developments/${id}/review`, { method: 'POST', body: { decision: action, reason } }),
    onSuccess: () => invalidate(storyId),
  });
}

// ---- Corrections ----

export const useCorrections = (storyId: string, enabled = true) =>
  useQuery({ queryKey: keys.corrections(storyId), queryFn: () => api<Correction[]>(`/api/stories/${storyId}/corrections`), enabled });

export function useCreateCorrection(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: CreateCorrectionInput) => api<{ id: string }>(`/api/stories/${storyId}/corrections`, { method: 'POST', body: input }),
    onSuccess: () => invalidate(storyId),
  });
}

/** Reviewers accept or reject a correction with a public note, or remove an abusive one. */
export function useModerateCorrection(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (
      input:
        | { id: string; action: 'resolve'; decision: 'accepted' | 'rejected'; note: string; fixedRevisionId?: string | null }
        | { id: string; action: 'remove'; reason?: string },
    ) =>
      input.action === 'remove'
        ? api(`/api/corrections/${input.id}/remove`, { method: 'POST', body: { reason: input.reason } })
        : api(`/api/corrections/${input.id}/resolve`, {
            method: 'POST',
            body: { decision: input.decision, note: input.note, fixedRevisionId: input.fixedRevisionId ?? null },
          }),
    onSuccess: () => invalidate(storyId),
  });
}

// ---- Collections ----

export const useCollections = (kind?: CollectionKind) =>
  useInfiniteQuery({
    queryKey: keys.collections(kind),
    queryFn: ({ pageParam }) => api<Page<CollectionSummary>>(`/api/collections?${queryString({ kind, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });

export const useCollection = (id: string | undefined) =>
  useQuery({ queryKey: keys.collection(id ?? ''), queryFn: () => api<CollectionDetail>(`/api/collections/${id}`), enabled: !!id });

/** Creates a collection (no id) or replaces one's contents. */
export function useSaveCollection(id?: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: CollectionInput) =>
      id
        ? api<{ ok: true }>(`/api/collections/${id}`, { method: 'PUT', body: input }).then(() => ({ id }))
        : api<{ id: string }>('/api/collections', { method: 'POST', body: input }),
    onSuccess: () => invalidate(),
  });
}

export function useModerateCollection(id: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (input: { status: 'active' | 'hidden'; reason?: string } | { featured: boolean }) =>
      'featured' in input
        ? api(`/api/collections/${id}/featured`, { method: 'POST', body: input })
        : api(`/api/collections/${id}/status`, { method: 'POST', body: input }),
    onSuccess: () => invalidate(),
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
    for (const key of ['user', 'mod-users', 'ban-requests', 'audit-log', 'revision', 'revisions', 'developments', 'corrections']) qc.invalidateQueries({ queryKey: [key] });
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
  useQuery({ queryKey: ['rules'], queryFn: () => api<Rules>('/api/rules'), staleTime: 60_000, placeholderData: RULES as Rules });

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

// ---- Place search ----

const PLACE_LANGUAGES = ['en', 'de', 'fr', 'it'];
const placeLanguage = () => {
  const lang = navigator.language?.slice(0, 2).toLowerCase();
  return lang && PLACE_LANGUAGES.includes(lang) ? lang : 'en';
};

/** Places matching what's typed in the map's search box (2+ characters), each with the hexagon to open. */
export const usePlaces = (query: string) => {
  const q = query.trim();
  return useQuery({
    queryKey: ['places', q.toLowerCase()],
    queryFn: () => api<Place[]>(`/api/places?${queryString({ q, lang: placeLanguage() })}`),
    enabled: q.length >= 2,
    staleTime: 60 * 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
};

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
