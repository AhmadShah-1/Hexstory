import { CATEGORIES, CATEGORY_LABELS, LIMITS, type Category } from '@hexstory/shared';
import { CATEGORY_COLORS } from '../lib/palette';

/** Small coloured labels for a story's categories. */
export function CategoryChips({ categories, small = false }: { categories: readonly Category[]; small?: boolean }) {
  if (!categories.length) return null;
  return (
    <span className={`category-chips ${small ? 'category-chips-small' : ''}`}>
      {categories.map((c) => (
        <span key={c} className="category-chip" style={{ '--chip': CATEGORY_COLORS[c] } as React.CSSProperties}>
          {CATEGORY_LABELS[c]}
        </span>
      ))}
    </span>
  );
}

/**
 * Toggle buttons for choosing categories: in the editor (at most LIMITS.categoriesMax) and in filters
 * (any number; none selected means all).
 */
export function CategoryPicker({
  value,
  onChange,
  max = CATEGORIES.length,
  label,
}: {
  value: readonly Category[];
  onChange: (next: Category[]) => void;
  max?: number;
  label: string;
}) {
  const toggle = (c: Category) => {
    if (value.includes(c)) onChange(value.filter((x) => x !== c));
    else if (value.length < max) onChange([...value, c]);
  };
  return (
    <div className="category-picker" role="group" aria-label={label}>
      {CATEGORIES.map((c) => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            type="button"
            className={`category-toggle ${on ? 'is-on' : ''}`}
            aria-pressed={on}
            disabled={!on && value.length >= max}
            style={{ '--chip': CATEGORY_COLORS[c] } as React.CSSProperties}
            onClick={() => toggle(c)}
          >
            <span className="category-dot" aria-hidden="true" />
            {CATEGORY_LABELS[c]}
          </button>
        );
      })}
    </div>
  );
}

export const EDITOR_CATEGORY_MAX = LIMITS.categoriesMax;
