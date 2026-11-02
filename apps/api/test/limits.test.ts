import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, RULES, TRUST, editableFrom, type AuditEntry, type EditableRules, type Page, type UserProfile } from '@hexstory/shared';
import { forgetRules } from '../src/services/settings.js';
import { refreshTrust } from '../src/services/users.js';
import { makeUser, setup, storyInput } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  forgetRules();
  await ctx.app.close();
  await ctx.sql.end();
});

type Headers = Record<string, string>;
const MB = 1024 * 1024;
const put = (url: string, headers: Headers, payload: object) => ctx.app.inject({ method: 'PUT', url, headers, payload });
const intent = (headers: Headers, size: number) => ctx.app.inject({ method: 'POST', url: '/api/uploads', headers, payload: { size } });

describe('site rules set by moderators', () => {
  const defaults = editableFrom(RULES);

  it('only moderators can change them, and only to consistent values', async () => {
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    expect((await ctx.app.inject({ url: '/api/moderation/settings', headers: reviewer.headers })).statusCode).toBe(403);
    expect((await put('/api/moderation/settings', reviewer.headers, { rules: defaults })).statusCode).toBe(403);

    const bad = await put('/api/moderation/settings', mod.headers, { rules: { ...defaults, reviewerMinAgeDays: 1, memberMinAgeDays: 5 } });
    expect(bad.statusCode).toBe(400);
    expect((await put('/api/moderation/settings', mod.headers, { rules: { ...defaults, memberMinAgeDays: -1 } })).statusCode).toBe(400);
  });

  it('applies new promotion thresholds, publishes them, and logs the change', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const newcomer = await makeUser(ctx.sql, { ageDays: 0 });
    const next: EditableRules = { ...defaults, memberMinAgeDays: 0, memberMinReputation: 0 };
    const saved = await put('/api/moderation/settings', mod.headers, { rules: next, reason: 'quiet launch' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().rules).toEqual(next);

    const published = (await ctx.app.inject({ url: '/api/rules' })).json();
    expect(published.promotion.member).toMatchObject({ minAgeDays: 0, minReputation: 0 });
    expect(published.storiesPerDay).toEqual(RULES.storiesPerDay);

    // Promotion is re-checked at the next contribution or sign-in.
    await refreshTrust(ctx.sql, newcomer.id);
    expect((await ctx.app.inject({ url: `/api/users/${newcomer.id}` })).json<UserProfile>().trustLevel).toBe(TRUST.MEMBER);

    const log = (await ctx.app.inject({ url: '/api/moderation/log?action=settings', headers: mod.headers })).json<Page<AuditEntry>>();
    expect(log.items[0]).toMatchObject({
      action: 'settings:rules',
      reason: 'quiet launch',
      target: { label: 'Site rules' },
      details: { from: { memberMinAgeDays: 3, memberMinReputation: 15 }, to: { memberMinAgeDays: 0, memberMinReputation: 0 } },
    });

    await put('/api/moderation/settings', mod.headers, { rules: defaults });
    expect((await ctx.app.inject({ url: '/api/rules' })).json().promotion.member.minAgeDays).toBe(RULES.promotion.member.minAgeDays);
  });
});

describe('size limits', () => {
  it('refuses stories whose stored content is too large, even within the character limit', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    // ~300 short links with long addresses: few characters of text, a lot of stored data.
    const href = `https://example.org/${'a'.repeat(240)}`;
    const links = Array.from({ length: 300 }, () => ({ type: 'text' as const, text: 'x ', href }));
    const content = [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'A crowd gathered in the square for days.' }, ...links] }];
    expect(JSON.stringify(content).length).toBeGreaterThan(LIMITS.contentBytesMax);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/stories', headers: member.headers, payload: storyInput({ content }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/too large/);
  });

  it('refuses oversized request bodies outright', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: { ...member.headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ ...storyInput(), padding: 'x'.repeat(300 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });

  it('caps photo uploads per day by count', async () => {
    const newcomer = await makeUser(ctx.sql);
    for (let i = 0; i < RULES.uploadsPerDay[TRUST.NEW]; i++) expect((await intent(newcomer.headers, 1000)).statusCode).toBe(201);
    const over = await intent(newcomer.headers, 1000);
    expect(over.statusCode).toBe(429);
    expect(over.json().message).toMatch(/photo uploads/);
  });

  it('caps photo uploads per day by total size, and shows usage on the account page', async () => {
    const newcomer = await makeUser(ctx.sql);
    const big = 6 * MB - 1;
    const fits = Math.floor((RULES.uploadMegabytesPerDay[TRUST.NEW] * MB) / big);
    for (let i = 0; i < fits; i++) expect((await intent(newcomer.headers, big)).statusCode).toBe(201);
    expect((await intent(newcomer.headers, big)).statusCode).toBe(429);

    const me = (await ctx.app.inject({ url: `/api/users/${newcomer.id}`, headers: newcomer.headers })).json<UserProfile>();
    expect(me.details?.today).toMatchObject({ uploads: fits, uploadsLimit: RULES.uploadsPerDay[0], uploadMegabytesLimit: RULES.uploadMegabytesPerDay[0] });
    expect(me.details?.today.uploadMegabytes).toBeCloseTo((fits * big) / MB, 0);
  });

  it('enforces the upload quota under parallel requests', async () => {
    const newcomer = await makeUser(ctx.sql);
    const results = await Promise.all(Array.from({ length: 15 }, () => intent(newcomer.headers, 1000)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(RULES.uploadsPerDay[TRUST.NEW]);
  });
});
