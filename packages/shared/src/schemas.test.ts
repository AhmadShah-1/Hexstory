import { describe, expect, it } from 'vitest';
import { collectionSchema, displayNameSchema, isReservedName } from './schemas.js';

describe('display names', () => {
  it('reserves the site, archive, deleted-user and staff names, including lookalikes', () => {
    for (const name of ['Hexstory Archive', 'hexstory-archive', 'HEXSTORY', 'The Hexstory Team', 'Deleted user', 'Deleted.User', 'Admin', 'moderator']) {
      expect(isReservedName(name)).toBe(true);
      expect(displayNameSchema.safeParse(name).success).toBe(false);
    }
    for (const name of ['Amina', 'History buff', 'Deleted user stories fan']) expect(isReservedName(name)).toBe(false);
  });
});

describe('collections', () => {
  const base = { title: 'Wars of the century', description: 'Every war of the twentieth century on the map.', kind: 'theme' as const };
  it('caps years so year * 10000 stays inside a Postgres int', () => {
    expect(collectionSchema.safeParse({ ...base, fromYear: 1900, toYear: 10_000 }).success).toBe(true);
    expect(collectionSchema.safeParse({ ...base, toYear: 9_999_999 }).success).toBe(false);
    expect(collectionSchema.safeParse({ ...base, fromYear: 214_749 }).success).toBe(false);
  });
});
