import { CLARITY_PROJECT_ID } from '../features';

/**
 * Microsoft Clarity (session recordings and heatmaps). Loaded from our own bundle rather than an inline
 * <script> so the strict CSP (`script-src 'self'` + the Clarity origins in apps/api/src/app.ts) still holds.
 * Production builds only, so local development never records sessions. See docs/DESIGN.md §8.
 */
type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

const enabled = import.meta.env.PROD && CLARITY_PROJECT_ID !== '';
let started = false;

// TODO: cookie consent banner for EU/UK/Swiss visitors that passes their choice to Clarity
// (`window.clarity('consentv2', …)`). Tracked in docs/DESIGN.md §13.

/** Injects the Clarity tag once. Calls made before it loads are queued, as in Clarity's own snippet. */
export function startClarity() {
  if (!enabled || started) return;
  started = true;
  const queue: ClarityFn = (...args) => {
    (queue.q ??= []).push(args);
  };
  window.clarity ??= queue;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(CLARITY_PROJECT_ID)}`;
  document.head.appendChild(script);
}

/**
 * Tags the session with the signed-in person so recordings can be searched by them: the public user id
 * as Clarity's custom id (Clarity hashes it in the browser) and the public display name as the friendly
 * name plus a `display_name` tag. Never the email or Google id: those don't leave the API.
 */
export function identifyClarityUser(user: { id: string; displayName: string }) {
  if (!enabled || !window.clarity) return;
  window.clarity('identify', user.id, undefined, undefined, user.displayName);
  window.clarity('set', 'display_name', user.displayName);
}
