import { FEATURES } from '../features';

export type AdPlacement = 'story-list-end' | 'story-end';

/**
 * Reserved place for sponsorship or ads. Renders nothing unless FEATURES.ads is on.
 * Keeping placements named and few means turning ads on later never touches view code.
 */
export function AdSlot({ placement }: { placement: AdPlacement }) {
  if (!FEATURES.ads) return null;
  return <div className="ad-slot" data-placement={placement} aria-label="Sponsored" />;
}
