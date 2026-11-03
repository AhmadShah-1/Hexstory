/**
 * Feature flags. Build-time switches (VITE_*) so disabled features ship no behaviour.
 * See docs/DESIGN.md "Extension points" before turning any of these on.
 */
export const FEATURES = {
  /** Reserved ad placements (<AdSlot />). Off by default; needs a CSP + privacy policy update first. */
  ads: import.meta.env.VITE_FEATURE_ADS === 'true',
} as const;

export const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/positron';

/** Microsoft Clarity project (public id). Production builds only; set VITE_CLARITY_PROJECT_ID='' to turn it off. */
export const CLARITY_PROJECT_ID = import.meta.env.VITE_CLARITY_PROJECT_ID ?? 'z80oz1x04t';
