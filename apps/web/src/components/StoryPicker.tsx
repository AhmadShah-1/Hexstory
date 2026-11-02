import { useEffect, useId, useState } from 'react';
import { formatEventDate, type StorySummary } from '@hexstory/shared';
import { useStoryList } from '../api/queries';

/**
 * "Find a story" box: type a few letters of a title, place or person and pick from published stories.
 * Used to connect stories to each other and to add stories to collections. `exclude` hides ids already
 * chosen (and the story being edited).
 */
export function StoryPicker({ onPick, exclude = [], placeholder = 'Search stories by title, place or person' }: {
  onPick: (story: StorySummary) => void;
  exclude?: readonly string[];
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const results = useStoryList({ q: query, sort: 'relevance' }, query.length >= 2);
  const items = (results.data?.pages[0]?.items ?? []).filter((s) => !exclude.includes(s.id)).slice(0, 8);
  const show = query.length >= 2;

  return (
    <div className="story-picker">
      <input
        type="search"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-controls={listId}
        autoComplete="off"
        maxLength={100}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter picks the top result instead of submitting the surrounding form.
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items[0]) {
              onPick(items[0]);
              setText('');
            }
          }
        }}
      />
      {show && (
        <ul className="story-picker-results" id={listId}>
          {items.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(s);
                  setText('');
                }}
              >
                <span className="story-picker-title">{s.title}</span>
                <span className="muted small">{[formatEventDate(s), s.placeName].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
          {!items.length && <li className="muted small story-picker-empty">{results.isFetching ? 'Searching…' : 'No published stories match.'}</li>}
        </ul>
      )}
    </div>
  );
}
