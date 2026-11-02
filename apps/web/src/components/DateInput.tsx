import type { ReactNode } from 'react';
import { LIMITS, type DateParts } from '@hexstory/shared';

/**
 * Form inputs shared by the story editor, the development editor and the correction dialog: historical
 * dates, source lists and the labelled field wrapper.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface DateDraft { year: string; era: 'CE' | 'BCE'; month: string; day: string }

/** Most stories are about recent events, so dates start at today. */
export function todayDraft(): DateDraft {
  const now = new Date();
  return { year: String(now.getFullYear()), era: 'CE', month: String(now.getMonth() + 1), day: String(now.getDate()) };
}

export function toDateDraft(d: DateParts | null | undefined): DateDraft {
  if (!d) return todayDraft();
  return { year: String(Math.abs(d.year)), era: d.year < 0 ? 'BCE' : 'CE', month: d.month ? String(d.month) : '', day: d.day ? String(d.day) : '' };
}

export function fromDateDraft(d: DateDraft): DateParts {
  // An empty year becomes NaN so validation says "Enter the year" rather than "There is no year 0".
  const year = d.year ? Number(d.year) * (d.era === 'BCE' ? -1 : 1) : NaN;
  return { year, month: d.month ? Number(d.month) : null, day: d.month && d.day ? Number(d.day) : null };
}

export function DateInput({ value, onChange, label }: { value: DateDraft; onChange: (v: DateDraft) => void; label?: string }) {
  const set = (patch: Partial<DateDraft>) => onChange({ ...value, ...patch });
  const prefix = label ? `${label} ` : '';
  return (
    <div className={`date-input ${value.era === 'BCE' ? 'date-input-era' : ''}`}>
      <input
        aria-label={`${prefix}year`}
        placeholder="Year"
        inputMode="numeric"
        value={value.year}
        onChange={(e) => set({ year: e.target.value.replace(/\D/g, '').slice(0, 5) })}
      />
      {/* BCE is supported but rare; the era picker only appears for dates that already use it. */}
      {value.era === 'BCE' && (
        <select aria-label={`${prefix}era`} value={value.era} onChange={(e) => set({ era: e.target.value as 'CE' | 'BCE' })}>
          <option value="CE">CE</option>
          <option value="BCE">BCE</option>
        </select>
      )}
      <select aria-label={`${prefix}month`} value={value.month} onChange={(e) => set({ month: e.target.value, day: e.target.value ? value.day : '' })}>
        <option value="">Month</option>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        aria-label={`${prefix}day`}
        placeholder="Day"
        inputMode="numeric"
        disabled={!value.month}
        value={value.day}
        onChange={(e) => set({ day: e.target.value.replace(/\D/g, '').slice(0, 2) })}
      />
    </div>
  );
}

export interface SourceDraft { title: string; url: string }

/** Filled-in rows only; a row with just a link uses the link as its title. */
export const sourcesFromDrafts = (drafts: SourceDraft[]) =>
  drafts
    .filter((s) => s.title.trim() || s.url.trim())
    .map((s) => ({ title: s.title.trim() || s.url.trim(), url: s.url.trim() || null }));

/** Title + optional link rows, with add and remove. */
export function SourcesInput({ value, onChange, addLabel = '+ Add another source' }: {
  value: SourceDraft[];
  onChange: (next: SourceDraft[]) => void;
  addLabel?: string;
}) {
  const update = (i: number, patch: Partial<SourceDraft>) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
      {value.map((s, i) => (
        <div className="source-input" key={i}>
          <input
            value={s.title}
            aria-label={`Source ${i + 1} title`}
            placeholder="Title (book, article, eyewitness…)"
            maxLength={LIMITS.sourceTitleMax}
            onChange={(e) => update(i, { title: e.target.value })}
          />
          <input
            value={s.url}
            aria-label={`Source ${i + 1} link`}
            placeholder="Link (optional)"
            inputMode="url"
            maxLength={LIMITS.sourceUrlMax}
            onChange={(e) => update(i, { url: e.target.value })}
          />
          {value.length > 1 && (
            <button type="button" className="icon-button" aria-label={`Remove source ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ×
            </button>
          )}
        </div>
      ))}
      {value.length < LIMITS.sourcesMax && (
        <button type="button" className="link-button" onClick={() => onChange([...value, { title: '', url: '' }])}>
          {addLabel}
        </button>
      )}
    </>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className={`field ${error ? 'field-error' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
      {error && <span className="error-text">{error}</span>}
    </label>
  );
}

/** First message per top-level field, from a Zod error. */
export function fieldErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[String(issue.path[0] ?? 'form')] ??= issue.message;
  return out;
}
