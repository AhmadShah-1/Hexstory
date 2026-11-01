import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { RULES, editableFrom, editableRulesSchema, type EditableRules } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useModSettings, useUpdateModSettings } from '../api/queries';
import { shortDate } from '../lib/format';
import { useToast } from './Toast';

const DEFAULTS = editableFrom(RULES);

const FIELDS: { key: keyof EditableRules; label: string; unit: string; group: 'member' | 'reviewer' | 'chat' }[] = [
  { key: 'memberMinAgeDays', label: 'Newcomer period: days before someone can become a Member', unit: 'days', group: 'member' },
  { key: 'memberMinStories', label: 'Published stories they must have contributed to', unit: 'stories', group: 'member' },
  { key: 'reviewerMinAgeDays', label: 'Days since joining before someone can become a Reviewer', unit: 'days', group: 'reviewer' },
  { key: 'reviewerMinStories', label: 'Published stories they must have contributed to', unit: 'stories', group: 'reviewer' },
  { key: 'reviewerMinOthersStories', label: '…of which started by someone else', unit: 'stories', group: 'reviewer' },
  { key: 'chatMinAccountMinutes', label: 'Minutes a new account waits before posting in the Square', unit: 'minutes', group: 'chat' },
];

const GROUPS = { member: 'Becoming a Member', reviewer: 'Becoming a Reviewer', chat: 'The Square' } as const;

/** "Newcomer period 3 → 1 days · …" for an audit-log entry of a rules change. */
export function describeRuleChanges(details: Record<string, unknown> | null): string {
  const from = (details?.from ?? {}) as Record<string, unknown>;
  const to = (details?.to ?? {}) as Record<string, unknown>;
  return FIELDS.filter((f) => f.key in to)
    .map((f) => `${f.label.split(':')[0]?.replace('…', '')} (${GROUPS[f.group]}) ${String(from[f.key])} → ${String(to[f.key])} ${f.unit}`)
    .join(' · ');
}

/** Moderators: the rules that can change without a deploy (promotion thresholds, the chat wait). */
export function ModSettings() {
  const settings = useModSettings();
  const save = useUpdateModSettings();
  const toast = useToast();
  const [form, setForm] = useState<Record<keyof EditableRules, string> | null>(null);
  const [reason, setReason] = useState('');

  // Start from the saved values once they arrive (and again after saving).
  const saved = settings.data?.rules;
  useEffect(() => {
    if (saved) setForm(toForm(saved));
  }, [saved]);

  if (settings.isLoading || !form) return <p className="muted">Loading…</p>;
  if (settings.error) return <p className="error-text">{errorMessage(settings.error)}</p>;

  const values = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? NaN : Number(v)]));
  const parsed = editableRulesSchema.safeParse(values);
  const fieldErrors = new Map(parsed.success ? [] : parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
  const dirty = !!saved && parsed.success && FIELDS.some((f) => parsed.data[f.key] !== saved[f.key]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed.success) return;
    save.mutate(
      { rules: parsed.data, reason: reason.trim() || undefined },
      { onSuccess: () => { toast('Rules saved'); setReason(''); } },
    );
  };

  return (
    <form className="mod-settings" onSubmit={submit} noValidate>
      <p className="small muted">
        Changes are enforced everywhere within a minute; the <Link to="/about">About page</Link> shows the new numbers
        to people who open it afterwards (pages already open catch up within a few minutes).
        Promotion is re-checked the next time someone contributes or signs in. Lowering a requirement never demotes
        anyone, and people whose level a moderator set by hand aren't affected.
      </p>

      {(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((group) => (
        <fieldset key={group} className="mod-settings-group">
          <legend className="section-label">{GROUPS[group]}</legend>
          {FIELDS.filter((f) => f.group === group).map((f) => {
            const error = fieldErrors.get(f.key);
            return (
              <label key={f.key} className={`field ${error ? 'field-error' : ''}`}>
                <span>{f.label}</span>
                <div className="row">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    className="mod-settings-number"
                    value={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    aria-invalid={!!error}
                  />
                  <span className="muted small">{f.unit} · default {DEFAULTS[f.key]}</span>
                </div>
                {error && <span className="error-text">{error.startsWith('Invalid') || error.startsWith('Too') ? 'Enter a whole number in range' : error}</span>}
              </label>
            );
          })}
        </fieldset>
      ))}

      <label className="field">
        <span>Reason (optional, shown in the audit log)</span>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      {save.error && <p className="error-text">{errorMessage(save.error)}</p>}
      <div className="action-row">
        <button type="submit" className="button button-primary" disabled={!dirty || save.isPending}>Save rules</button>
        <button type="button" className="button button-quiet" onClick={() => setForm(toForm(DEFAULTS))}>Reset to defaults</button>
      </div>
      {settings.data?.updated && (
        <p className="small muted">
          Last changed {shortDate(settings.data.updated.at)} by{' '}
          <Link to={`/u/${settings.data.updated.by.id}`}>{settings.data.updated.by.displayName}</Link>.
        </p>
      )}
    </form>
  );
}

const toForm = (rules: EditableRules) =>
  Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, String(v)])) as Record<keyof EditableRules, string>;
