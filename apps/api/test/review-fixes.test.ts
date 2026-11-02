import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { TRUST, cellAt, type Page, type AuditEntry, type ContributionStory, type RevisionListItem, type StoryDetail, type UserProfile } from '@hexstory/shared';
import { POLICY } from '../src/policy.js';
import { ORIGIN, makeUser, setup, storyInput } from './helpers.js';

/** Regression tests for the security and data-flow review fixes (2026-11-01). */
let ctx: Awaited<ReturnType<typeof setup>>;
let url: string;

beforeAll(async () => {
  ctx = await setup();
  url = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

type Headers = Record<string, string>;
const get = <T>(path: string, headers: Headers = {}) => ctx.app.inject({ url: path, headers }).then((r) => ({ status: r.statusCode, body: r.json<T>() }));
const post = (path: string, headers: Headers, payload: object = {}) => ctx.app.inject({ method: 'POST', url: path, headers, payload });
const create = async (headers: Headers, overrides: Parameters<typeof storyInput>[0] = {}) =>
  (await post('/api/stories', headers, storyInput(overrides))).json<{ storyId: string; revisionId: string }>();
const edit = async (headers: Headers, storyId: string, overrides: Parameters<typeof storyInput>[0] = {}) => {
  const base = (await get<StoryDetail>(`/api/stories/${storyId}`, headers)).body.revision.id;
  return ctx.app.inject({ method: 'PUT', url: `/api/stories/${storyId}`, headers, payload: { ...storyInput(overrides), baseRevisionId: base } });
};

describe('publication', () => {
  it("keeps a newcomer's drafts private after the story is approved", async () => {
    const newcomer = await makeUser(ctx.sql);
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const draft = await create(newcomer.headers, { title: 'A draft with something nasty in it' });
    const final = (await edit(newcomer.headers, draft.storyId, { title: 'The cleaned-up final story' })).json<{ revisionId: string }>();
    await post(`/api/stories/${draft.storyId}/status`, reviewer.headers, { status: 'active', revisionId: final.revisionId });

    expect((await get(`/api/revisions/${draft.revisionId}`)).status).toBe(404);
    expect((await get(`/api/revisions/${final.revisionId}`)).status).toBe(200);
    expect((await get<RevisionListItem[]>(`/api/stories/${draft.storyId}/revisions`)).body.map((r) => r.id)).toEqual([final.revisionId]);
    // Their author and reviewers still see them.
    expect((await get(`/api/revisions/${draft.revisionId}`, newcomer.headers)).status).toBe(200);
    expect((await get(`/api/revisions/${draft.revisionId}`, reviewer.headers)).status).toBe(200);

    // Later edits are public as usual.
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const later = (await edit(member.headers, draft.storyId, { title: 'Improved after publication' })).json<{ revisionId: string }>();
    expect((await get(`/api/revisions/${later.revisionId}`)).status).toBe(200);
  });

  it('refuses repeated or stale decisions, and unhiding never publishes an unapproved story', async () => {
    const newcomer = await makeUser(ctx.sql);
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const { storyId, revisionId } = await create(newcomer.headers);

    // Rejected (hidden) by one reviewer; a stale "approve" from another must not publish it.
    expect((await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'hidden' })).statusCode).toBe(200);
    const stale = await post(`/api/stories/${storyId}/status`, mod.headers, { status: 'active', revisionId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('already-decided');
    expect((await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'hidden' })).statusCode).toBe(409);

    const unhide = await post(`/api/stories/${storyId}/status`, mod.headers, { status: 'active' });
    expect(unhide.json().status).toBe('unreviewed');
    expect((await get(`/api/stories/${storyId}`)).status).toBe(404);

    // Hiding closes the reports about it.
    await post('/api/reports', reviewer.headers, { targetType: 'story', targetId: storyId, reason: 'spam' });
    await post(`/api/stories/${storyId}/status`, mod.headers, { status: 'hidden' });
    const tower = (await get<{ reports: { targetId: string }[] }>('/api/watchtower', reviewer.headers)).body;
    expect(tower.reports.some((r) => r.targetId === storyId)).toBe(false);
  });

  it('shows a rejected new story as not accepted, without the current title of hidden stories', async () => {
    const newcomer = await makeUser(ctx.sql);
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = await create(newcomer.headers, { title: 'My first attempt at a story' });
    await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'hidden' });
    const mine = (await get<Page<ContributionStory>>(`/api/users/${newcomer.id}/stories`, newcomer.headers)).body.items;
    expect(mine.find((s) => s.story.id === storyId)).toMatchObject({ state: 'rejected', story: { title: 'My first attempt at a story' } });
  });

  it('applies story protection to accepting held edits, and guards restores against double clicks', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const { storyId, revisionId: first } = await create(member.headers);
    await post(`/api/stories/${storyId}/protection`, mod.headers, { level: 3, reason: 'edit war' });
    const held = (await edit(member.headers, storyId, { title: 'A held edit on a protected story' })).json<{ revisionId: string }>();
    expect((await post(`/api/revisions/${held.revisionId}/review`, reviewer.headers, { decision: 'accept' })).statusCode).toBe(403);
    expect((await post(`/api/revisions/${held.revisionId}/review`, mod.headers, { decision: 'accept' })).statusCode).toBe(200);

    const restore = () => post(`/api/stories/${storyId}/restore`, mod.headers, { revisionId: first, baseRevisionId: held.revisionId });
    expect((await restore()).statusCode).toBe(200);
    expect((await restore()).statusCode).toBe(409);

    const log = (await get<Page<AuditEntry>>(`/api/moderation/log?targetId=${storyId}`, mod.headers)).body.items;
    expect(log.find((e) => e.action === 'protect:3')).toMatchObject({ reason: 'edit war', details: { from: 0 } });
    expect(log.find((e) => e.action === 'restore')?.details).toMatchObject({ revisionId: first });
  });
});

describe('counts', () => {
  it("counts new stories as stories, not edits, and restores aren't the restorer's edits", async () => {
    const newcomer = await makeUser(ctx.sql);
    for (let i = 0; i < 3; i++) await create(newcomer.headers, { title: `Newcomer story ${i}` });
    const me = (await get<UserProfile>(`/api/users/${newcomer.id}`, newcomer.headers)).body;
    expect(me.details?.today).toMatchObject({ stories: 3, edits: 0 });
    expect(me.details?.stats).toMatchObject({ edits: 3, editsAccepted: 3, editsRemoved: 0 });

    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId, revisionId } = await create(member.headers);
    await edit(member.headers, storyId, { title: 'Changed by the member' });
    await post(`/api/stories/${storyId}/restore`, mod.headers, { revisionId });
    const modStats = (await get<UserProfile>(`/api/users/${mod.id}`, mod.headers)).body.details;
    expect(modStats?.stats.edits).toBe(0);
    expect(modStats?.today.edits).toBe(0);
  });

  it('promotes someone when they open their own page once they qualify', async () => {
    const user = await makeUser(ctx.sql, { ageDays: 10 });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    for (let i = 0; i < 3; i++) {
      const { storyId, revisionId } = await create(user.headers, { title: `Story to approve ${i}` });
      await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'active', revisionId });
    }
    // Simulate having qualified without any new activity since (e.g. age reached overnight).
    await ctx.sql`UPDATE users SET trust_level = 0 WHERE id = ${user.id}`;
    expect((await get<UserProfile>(`/api/users/${user.id}`, user.headers)).body.trustLevel).toBe(TRUST.MEMBER);
  });
});

describe('access', () => {
  it('lets moderators act on someone taken off ADMIN_EMAILS without waiting for them', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const former = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    await ctx.sql`UPDATE users SET email = 'former-mod@example.com' WHERE id = ${former.id}`;
    const ban = await post(`/api/users/${former.id}/ban`, mod.headers, { banned: true, reason: 'abused moderator powers' });
    expect(ban.statusCode).toBe(200);
    expect((await get<UserProfile>(`/api/users/${former.id}`)).body.trustLevel).toBe(TRUST.REVIEWER);
  });

  it('keeps a banned person out after a moderator deletes their account', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const banned = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const [row0] = await ctx.sql<{ googleSub: string }[]>`SELECT google_sub FROM users WHERE id = ${banned.id}`;
    const googleSub = row0!.googleSub;
    await post(`/api/users/${banned.id}/ban`, mod.headers, { banned: true });
    expect((await post(`/api/users/${banned.id}/delete`, mod.headers, { removeContent: false })).statusCode).toBe(200);
    const [row] = await ctx.sql`SELECT 1 FROM banned_subjects WHERE sub_hash = ${createHash('sha256').update(googleSub).digest('hex')}`;
    expect(row).toBeTruthy();
    // The sign-in callback checks this table before creating an account (auth/google.ts).
  });

  it('applies the origin check and session to percent-encoded API paths', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/%61pi/stories',
      headers: { cookie: member.headers.cookie, origin: 'https://evil.example' },
      payload: storyInput(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('uploads', () => {
  const jpeg = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } }).jpeg().toBuffer();

  it('only accepts originals into a slot the user reserved, and completes each slot once', async () => {
    const owner = await makeUser(ctx.sql);
    const attacker = await makeUser(ctx.sql);
    const bytes = await jpeg();
    const ticket = (await post('/api/uploads', owner.headers, { size: bytes.length })).json<{ id: string; upload: { url: string; headers: Headers } }>();
    await ctx.app.inject({ method: 'PUT', url: ticket.upload.url, headers: { ...owner.headers, ...ticket.upload.headers }, payload: bytes });
    expect((await post(`/api/uploads/${ticket.id}/complete`, owner.headers)).statusCode).toBe(201);

    // Re-uploading into the used slot (to replace the published image) is refused...
    const again = await ctx.app.inject({ method: 'PUT', url: ticket.upload.url, headers: { ...owner.headers, ...ticket.upload.headers }, payload: bytes });
    expect(again.statusCode).toBe(404);
    // ...and so is someone else writing to that id.
    const stranger = await ctx.app.inject({ method: 'PUT', url: `/api/uploads/${ticket.id}/original`, headers: { ...attacker.headers, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(stranger.statusCode).toBe(404);
    expect((await post(`/api/uploads/${ticket.id}/complete`, attacker.headers)).statusCode).toBe(404);
  });
});
