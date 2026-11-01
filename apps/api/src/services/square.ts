import { TRUST, type ChatMessage } from '@hexstory/shared';
import type { SessionUser } from '../auth/sessions.js';
import type { Sql } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { POLICY, canReview } from '../policy.js';
import { logModAction } from './modlog.js';

export async function recentMessages(sql: Sql, cell: string, limit = 50): Promise<ChatMessage[]> {
  const rows = await sql<{ id: string; cell: string; userId: string; displayName: string; body: string; createdAt: Date }[]>`
    SELECT c.id, c.cell, c.user_id, u.display_name, c.body, c.created_at
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.cell = ${cell} AND c.hidden_at IS NULL AND u.banned_at IS NULL
    ORDER BY c.created_at DESC
    LIMIT ${limit}`;
  return rows.reverse().map(toMessage);
}

const toMessage = (r: { id: string; cell: string; userId: string; displayName: string; body: string; createdAt: Date }): ChatMessage => ({
  id: r.id,
  cell: r.cell,
  author: { id: r.userId, displayName: r.displayName },
  body: r.body,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Why a user can't post in the Square right now, or null if they can. The cooldown between
 * messages lives in shared state and is checked separately.
 */
export function chatBlockReason(user: SessionUser | null): string | null {
  if (!user) return 'Sign in to join the conversation.';
  if (user.bannedAt) return 'Your account has been suspended.';
  if (!user.termsAcceptedAt) return 'Please accept the terms first.';
  const ageMs = Date.now() - user.createdAt.getTime();
  if (user.trustLevel === TRUST.NEW && ageMs < POLICY.chatMinAccountAgeMs) {
    const minutes = Math.ceil((POLICY.chatMinAccountAgeMs - ageMs) / 60_000);
    return `New accounts can post in the Square after a few minutes (${minutes} min left). You can read along meanwhile.`;
  }
  return null;
}

export async function postMessage(sql: Sql, user: SessionUser, cell: string, body: string): Promise<ChatMessage> {
  const [row] = await sql<{ id: string; createdAt: Date }[]>`
    INSERT INTO comments (cell, user_id, body) VALUES (${cell}, ${user.id}, ${body}) RETURNING id, created_at`;
  return toMessage({ id: row!.id, cell, userId: user.id, displayName: user.displayName, body, createdAt: row!.createdAt });
}

export async function hideMessage(sql: Sql, user: SessionUser, id: string, reason: string | null): Promise<{ cell: string }> {
  if (!canReview(user.trustLevel)) throw forbidden();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ cell: string }[]>`
      UPDATE comments SET hidden_at = now() WHERE id = ${id} AND hidden_at IS NULL RETURNING cell`;
    if (!row) throw notFound('Message');
    await logModAction(tx, user.id, 'hide', 'comment', id, reason);
    return row;
  });
}
