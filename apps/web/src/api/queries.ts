import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CellCount,
  ChatMessage,
  CreateStoryInput,
  EditStoryInput,
  ReportReason,
  ReportTarget,
  RevisionListItem,
  SessionInfo,
  StoryDetail,
  StoryRevision,
  StorySummary,
  UploadTicket,
  UploadedImage,
  WatchtowerData,
} from '@hexstory/shared';
import { ApiError, api } from './client';

/** All query keys in one place so invalidation stays consistent. */
export const keys = {
  session: ['session'] as const,
  cells: (res: number) => ['cells', res] as const,
  cellStories: (cell: string) => ['cell-stories', cell] as const,
  story: (id: string) => ['story', id] as const,
  revisions: (id: string) => ['revisions', id] as const,
  revision: (id: string) => ['revision', id] as const,
  messages: (cell: string) => ['messages', cell] as const,
  watchtower: ['watchtower'] as const,
};

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

type WriteResult = { storyId: string; revisionId: string; status: 'live' | 'pending' };

/** After any write that can change what the map shows, refresh map + lists + the story itself. */
function useInvalidateStories() {
  const qc = useQueryClient();
  return (storyId?: string) => {
    qc.invalidateQueries({ queryKey: ['cells'] });
    qc.invalidateQueries({ queryKey: ['cell-stories'] });
    qc.invalidateQueries({ queryKey: keys.watchtower });
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

export function useSetStoryStatus(storyId: string) {
  const invalidate = useInvalidateStories();
  return useMutation({
    mutationFn: (status: 'active' | 'hidden') => api(`/api/stories/${storyId}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => invalidate(storyId),
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

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName?: string; acceptTerms?: true }) => api('/api/me', { method: 'PATCH', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.session }),
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
