import { diffWords } from 'diff';

/** Inline word-level diff, used by reviewers to see exactly what an edit changes. */
export function WordDiff({ before, after }: { before: string; after: string }) {
  const parts = diffWords(before, after);
  return (
    <p className="diff">
      {parts.map((part, i) =>
        part.added ? <ins key={i}>{part.value}</ins> : part.removed ? <del key={i}>{part.value}</del> : <span key={i}>{part.value}</span>,
      )}
    </p>
  );
}
