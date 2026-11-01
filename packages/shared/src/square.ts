import type { ChatMessage } from './types.js';

/**
 * Combines fetched history with messages received live. History and live events overlap after a
 * reconnect (a message can arrive live while history is being refetched), so messages are
 * de-duplicated by id, hidden ones are dropped, and the result is ordered oldest first.
 */
export function mergeMessages(history: ChatMessage[], live: ChatMessage[], hidden: ReadonlySet<string>): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of [...history, ...live]) if (!hidden.has(m.id) && !byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
