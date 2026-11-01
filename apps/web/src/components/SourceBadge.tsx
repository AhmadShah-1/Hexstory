/** Source count shown on every story; a quick, deliberately neutral credibility cue. */
export function SourceBadge({ count }: { count: number }) {
  const tier = count >= 4 ? 'many' : count >= 2 ? 'some' : 'one';
  return (
    <span className={`source-badge source-${tier}`} title="Number of sources listed (not yet verified)">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.5 7h5M5.5 9.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {count} {count === 1 ? 'source' : 'sources'}
    </span>
  );
}
