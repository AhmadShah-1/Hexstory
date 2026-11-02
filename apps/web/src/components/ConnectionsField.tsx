import { useState } from 'react';
import { LINK_RELATIONS, LIMITS, type LinkRelation } from '@hexstory/shared';
import { StoryPicker } from './StoryPicker';

export interface LinkDraft { storyId: string; relation: LinkRelation; title: string }

/** How each relation reads in a sentence about the story being written. */
const PHRASES: Record<LinkRelation, string> = {
  'preceded-by': 'was preceded or caused by',
  'led-to': 'led to',
  'part-of': 'is part of',
  includes: 'includes',
  related: 'is related to',
};

/**
 * Connections to other stories, made as easy as a search: choose how they relate ("This event led to…"),
 * find the story, done. Each link also shows on the other story, with the inverse relation.
 */
export function ConnectionsField({ value, onChange, selfId, error }: {
  value: LinkDraft[];
  onChange: (next: LinkDraft[]) => void;
  /** The story being edited, which can't be linked to itself. */
  selfId?: string;
  error?: string;
}) {
  const [relation, setRelation] = useState<LinkRelation>('related');
  const full = value.length >= LIMITS.linksMax;
  return (
    <fieldset className={`field connections-field ${error ? 'field-error' : ''}`}>
      <legend>Connections <span className="muted small">(optional)</span></legend>
      <p className="muted small">Link the events that led here, what this led to, or the larger event it belongs to.</p>
      {value.length > 0 && (
        <ul className="link-list">
          {value.map((l, i) => (
            <li key={l.storyId}>
              <select
                aria-label={`How it relates to ${l.title}`}
                value={l.relation}
                onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, relation: e.target.value as LinkRelation } : x)))}
              >
                {LINK_RELATIONS.map((r) => <option key={r} value={r}>This event {PHRASES[r]}</option>)}
              </select>
              <span className="link-title">{l.title}</span>
              <button type="button" className="icon-button" aria-label={`Remove connection to ${l.title}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <div className="link-add">
          <select aria-label="How the next story relates" value={relation} onChange={(e) => setRelation(e.target.value as LinkRelation)}>
            {LINK_RELATIONS.map((r) => <option key={r} value={r}>This event {PHRASES[r]}…</option>)}
          </select>
          <StoryPicker
            exclude={[...value.map((l) => l.storyId), ...(selfId ? [selfId] : [])]}
            placeholder="Find a story to connect"
            onPick={(s) => onChange([...value, { storyId: s.id, relation, title: s.title }])}
          />
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </fieldset>
  );
}
