import { describe, expect, it } from 'vitest';
import { mergeMessages } from './square.js';
import type { ChatMessage } from './types.js';

const msg = (id: string, second: number): ChatMessage => ({
  id,
  cell: '831fb4fffffffff',
  author: { id: 'u1', displayName: 'Ada' },
  body: `message ${id}`,
  createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, second)).toISOString(),
});

describe('mergeMessages', () => {
  it('drops duplicates when refetched history overlaps live messages after a reconnect', () => {
    const history = [msg('a', 1), msg('b', 2), msg('c', 3)];
    const live = [msg('c', 3), msg('d', 4)];
    expect(mergeMessages(history, live, new Set()).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('removes hidden messages and keeps chronological order', () => {
    const history = [msg('b', 2)];
    const live = [msg('a', 1), msg('c', 3)];
    expect(mergeMessages(history, live, new Set(['b'])).map((m) => m.id)).toEqual(['a', 'c']);
  });
});
