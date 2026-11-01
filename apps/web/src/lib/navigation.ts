import type { NavigateFunction } from 'react-router';

/**
 * Closes a page shown over the map (About, Terms, Support…): back to where you came from when that was
 * inside the app, otherwise to the map. React Router keeps its position in history.state.idx.
 */
export function closePage(navigate: NavigateFunction): void {
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (idx > 0) navigate(-1);
  else navigate('/');
}
