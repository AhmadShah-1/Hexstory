import { useState } from 'react';
import { LIMITS } from '@hexstory/shared';

/** People involved: type a name and press Enter (or comma). Each becomes a chip linking to their other stories. */
export function PeopleField({ value, onChange, error }: { value: string[]; onChange: (next: string[]) => void; error?: string }) {
  const [text, setText] = useState('');
  const add = () => {
    const name = text.trim().replace(/,$/, '').trim();
    if (name.length < LIMITS.personNameMin) return;
    if (!value.some((v) => v.toLowerCase() === name.toLowerCase())) onChange([...value, name]);
    setText('');
  };
  return (
    <div className={`field ${error ? 'field-error' : ''}`}>
      <label className="field-label" htmlFor="people-input">People involved <span className="muted small">(optional)</span></label>
      {value.length > 0 && (
        <ul className="people-chips">
          {value.map((p) => (
            <li key={p}>
              {p}
              <button type="button" aria-label={`Remove ${p}`} onClick={() => onChange(value.filter((x) => x !== p))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {value.length < LIMITS.peopleMax && (
        <input
          id="people-input"
          value={text}
          maxLength={LIMITS.personNameMax}
          placeholder="Type a name and press Enter"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          // A name typed but not confirmed still counts when leaving the field.
          onBlur={add}
        />
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
