import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { ApiError } from './api/client';
import { AppShell } from './layout/AppShell';
import { startClarity } from './lib/clarity';
import { HexView } from './views/HexView';
import { Home } from './views/Home';
import { NotFound } from './views/NotFound';
import type { PageName } from './views/PageView';
import { StoryView } from './views/StoryView';
import { VersionsView } from './views/VersionsView';
import './styles/global.css';
import './styles/discover.css';
import './styles/story.css';
import './styles/collections.css';

// Views most visitors never open are loaded on demand to keep the first load light.
const page = (name: PageName) => async () => {
  const { PageView } = await import('./views/PageView');
  return { element: <PageView page={name} /> };
};
const editor = async () => ({ Component: (await import('./views/StoryEditor')).StoryEditor });
const collectionEditor = async () => ({ Component: (await import('./views/CollectionEditor')).CollectionEditor });

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      // Guided discovery beside the map; the map stays the centrepiece.
      { index: true, element: <Home /> },
      { path: 'explore', lazy: async () => ({ Component: (await import('./views/Explore')).Explore }) },
      { path: 'near', lazy: async () => ({ Component: (await import('./views/NearMe')).NearMe }) },
      { path: 'h/:cell', element: <HexView /> },
      { path: 'new', lazy: editor },
      { path: 's/:id', element: <StoryView /> },
      { path: 's/:id/edit', lazy: editor },
      { path: 's/:id/versions', element: <VersionsView /> },
      { path: 's/:id/develop', lazy: async () => ({ Component: (await import('./views/DevelopmentEditor')).DevelopmentEditor }) },
      { path: 'collections', lazy: async () => ({ Component: (await import('./views/Collections')).Collections }) },
      { path: 'collections/new', lazy: collectionEditor },
      { path: 'c/:id', lazy: async () => ({ Component: (await import('./views/CollectionView')).CollectionView }) },
      { path: 'c/:id/edit', lazy: collectionEditor },
      { path: 'v/:revisionId', lazy: async () => ({ Component: (await import('./views/RevisionView')).RevisionView }) },
      { path: 'watchtower', lazy: async () => ({ Component: (await import('./views/Watchtower')).Watchtower }) },
      { path: 'moderation', lazy: async () => ({ Component: (await import('./views/Moderation')).Moderation }) },
      { path: 'me', lazy: async () => ({ Component: (await import('./views/AccountPage')).AccountPage }) },
      { path: 'u/:id', lazy: async () => ({ Component: (await import('./views/UserPage')).UserPage }) },
      { path: 'about', lazy: page('about') },
      { path: 'terms', lazy: page('terms') },
      { path: 'privacy', lazy: page('privacy') },
      { path: 'support', lazy: async () => ({ Component: (await import('./views/SupportView')).SupportView }) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Don't retry "not found" / "forbidden"; do retry flaky network errors.
      retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
});

startClarity();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
