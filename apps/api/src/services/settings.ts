import { TRUST, editableFrom, effectiveRules, type EditableRules, type Rules } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Db, Sql } from '../db.js';
import { forbidden } from '../errors.js';
import { logModAction } from './modlog.js';

/**
 * How long an instance trusts its copy of the rules. Several instances run at once on Vercel, so a
 * Moderator's change reaches all of them within this time (immediately on the instance that saved it).
 */
const RULES_TTL_MS = 30_000;
let cached: { at: number; rules: Rules } | null = null;

/** The rules in force: the defaults in code with the Moderators' overrides applied. */
export async function getRules(sql: Db): Promise<Rules> {
  if (cached && Date.now() - cached.at < RULES_TTL_MS) return cached.rules;
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM site_settings WHERE key = 'rules'`;
  cached = { at: Date.now(), rules: effectiveRules(row?.value) };
  return cached.rules;
}

/** Drops this instance's cached rules (after a change, and between tests). */
export function forgetRules(): void {
  cached = null;
}

/**
 * Saves new values for the editable rules (promotion thresholds, the new-account chat wait). Nobody is
 * re-evaluated on the spot: promotion is re-checked at each person's next accepted contribution or
 * sign-in, and lowering a requirement never demotes anyone.
 */
export async function updateRules(sql: Sql, actor: SessionUser, input: EditableRules, reason: string | null): Promise<Rules> {
  if (actor.trustLevel < TRUST.MODERATOR) throw forbidden();
  await sql.begin(async (tx) => {
    const [row] = await tx<{ value: unknown }[]>`SELECT value FROM site_settings WHERE key = 'rules' FOR UPDATE`;
    const before = editableFrom(effectiveRules(row?.value));
    await tx`
      INSERT INTO site_settings (key, value, updated_by) VALUES ('rules', ${tx.json(input)}, ${actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    const changed = (Object.keys(input) as (keyof EditableRules)[]).filter((k) => input[k] !== before[k]);
    await logModAction(tx, actor.id, 'settings:rules', 'settings', 'rules', reason, {
      from: Object.fromEntries(changed.map((k) => [k, before[k]])),
      to: Object.fromEntries(changed.map((k) => [k, input[k]])),
    });
  });
  forgetRules();
  return getRules(sql);
}

/** When and by whom the rules were last changed, for the Settings screen. */
export async function rulesUpdatedAt(sql: Sql): Promise<{ at: string; by: { id: string; displayName: string } } | null> {
  const [row] = await sql<{ updatedAt: Date; byId: string | null; byName: string | null }[]>`
    SELECT s.updated_at, u.id AS by_id, u.display_name AS by_name
    FROM site_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = 'rules'`;
  if (!row || !row.byId) return null;
  return { at: row.updatedAt.toISOString(), by: { id: row.byId, displayName: row.byName ?? '' } };
}
