import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Place } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { usePlaces } from '../api/queries';

/**
 * "Search for a place" box on the map. Suggestions appear as you type; Enter (or a click) opens the
 * hexagon for the highlighted place, the top one by default, and flies the map there. Towns and cities
 * open their finest hexagon, larger areas one bigger hexagon.
 *
 * With `onPick` (inside forms, e.g. choosing where a story happened) the chosen place is handed to the
 * caller instead, and the box sits inline (`className`) rather than floating over the map.
 */
export function PlaceSearch({
  onPick,
  placeholder = 'Search for a place',
  label = placeholder,
  className = 'place-search',
}: {
  onPick?: (place: Place) => void;
  placeholder?: string;
  label?: string;
  className?: string;
} = {}) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Ask once typing pauses, not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(t);
  }, [text]);

  const places = usePlaces(query);
  const results = query.trim().length >= 2 ? places.data ?? [] : [];
  const waiting = text.trim().length >= 2 && (text !== query || places.isFetching);
  useEffect(() => setActive(0), [places.data]);

  const choose = (place: Place | undefined) => {
    if (!place) return;
    setOpen(false);
    setText('');
    setQuery('');
    inputRef.current?.blur();
    if (onPick) onPick(place);
    else navigate(`/h/${place.cell}`, { state: { focus: true, placeName: place.name } });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active] ?? results[0]);
    } else if (e.key === 'Escape') {
      // Close the list first; a second Escape clears the box.
      e.preventDefault();
      e.stopPropagation();
      if (open && results.length) setOpen(false);
      else setText('');
    }
  };

  const showList = open && text.trim().length >= 2;
  return (
    <div className={className} role="search">
      <svg className="place-search-icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="m13 13 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        className="place-search-input"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Let a click on a suggestion land before the list closes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul className="place-results" id={listId} role="listbox" aria-label="Places">
          {results.map((p, i) => (
            <li
              key={`${p.cell}-${p.name}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(p)}
            >
              <span className="place-name">{p.name}</span>
              <span className="place-detail">{[p.kind, p.detail].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
          {!results.length && (
            <li className="place-status" role="presentation">
              {waiting ? 'Searching…' : places.error ? errorMessage(places.error) : 'No places found.'}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
