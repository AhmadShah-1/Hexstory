import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RULES,
  TRUST,
  type AuditEntry,
  type BanRequestGroup,
  type ContributionEdit,
  type ContributionStory,
  type ModUserRow,
  type Page,
  type RevisionListItem,
  type StoryDetail,
  type StorySummary,
  type UserProfile,
} from '@hexstory/shared';
import { cellToParent } from 'h3-js';
import { upsertGoogleUser } from '../src/auth/google.js';
import { refreshTrust } from '../src/services/users.js';
import { MODERATOR_EMAIL, PARIS, makeUser, setup, storyInput, testConfig } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

type Headers = Record<string, string>;
const get = <T>(url: string, headers: Headers = {}) => ctx.app.inject({ url, headers }).then((r) => ({ status: r.statusCode, body: r.json<T>() }));
const post = (url: string, headers: Headers, payload: object = {}) => ctx.app.inject({ method: 'POST', url, headers, payload });

const createStory = async (headers: Headers, overrides: Parameters<typeof storyInput>[0] = {}) =>
  (await post('/api/stories', headers, storyInput(overrides))).json<{ storyId: string; revisionId: string; status: string; storyStatus: string }>();

const editStory = async (headers: Headers, storyId: string, overrides: Parameters<typeof storyInput>[0] = {}) => {
  const base = (await get<StoryDetail>(`/api/stories/${storyId}`, headers)).body.revision.id;
  return ctx.app.inject({ method: 'PUT', url: `/api/stories/${storyId}`, headers, payload: { ...storyInput(overrides), baseRevisionId: base } });
};

const listCell = async (headers: Headers = {}) =>
  (await get<Page<StorySummary>>(`/api/cells/${cellToParent(PARIS, 4)}/stories`, headers)).body.items.map((s) => s.id);

describe('newcomer stories wait for approval', () => {
  it('stay private to their author and reviewers until a reviewer approves them', async () => {
    const newcomer = await makeUser(ctx.sql);
    const stranger = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const created = await createStory(newcomer.headers, { title: 'A newcomer draft story' });
    expect(created).toMatchObject({ status: 'live', storyStatus: 'unreviewed' });
    const { storyId } = created;

    expect((await get(`/api/stories/${storyId}`)).status).toBe(404);
    expect((await get(`/api/stories/${storyId}`, stranger.headers)).status).toBe(404);
    expect((await get(`/api/stories/${storyId}/revisions`)).status).toBe(404);
    expect((await get(`/api/revisions/${created.revisionId}`)).status).toBe(404);
    expect((await get(`/api/stories/${storyId}`, newcomer.headers)).status).toBe(200);
    expect((await get(`/api/stories/${storyId}`, reviewer.headers)).status).toBe(200);

    // Listed in its hex only for its author and reviewers; never tinted on the public map.
    expect(await listCell()).not.toContain(storyId);
    expect(await listCell(stranger.headers)).not.toContain(storyId);
    expect(await listCell(newcomer.headers)).toContain(storyId);
    expect(await listCell(reviewer.headers)).toContain(storyId);

    // Strangers can't edit what they can't see; the author keeps refining the draft.
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/stories/${storyId}`, headers: stranger.headers,
      payload: { ...storyInput(), baseRevisionId: created.revisionId } })).statusCode).toBe(404);
    const refined = await editStory(newcomer.headers, storyId, { title: 'A refined newcomer draft' });
    expect(refined.json()).toMatchObject({ status: 'live', storyStatus: 'unreviewed' });

    // Approving the version the reviewer read fails once the author has changed it.
    const stale = await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'active', revisionId: created.revisionId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stale');

    const approve = await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'active', revisionId: refined.json().revisionId });
    expect(approve.statusCode).toBe(200);
    expect((await get<StoryDetail>(`/api/stories/${storyId}`)).body.revision.title).toBe('A refined newcomer draft');
    expect(await listCell()).toContain(storyId);
  });

  it("doesn't let anyone approve their own story", async () => {
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = await createStory(reviewer.headers);
    await ctx.sql`UPDATE stories SET status = 'unreviewed' WHERE id = ${storyId}`;
    expect((await post(`/api/stories/${storyId}/status`, reviewer.headers, { status: 'active' })).statusCode).toBe(403);
  });

  it('publishes a held first version when a reviewer accepts it', async () => {
    const newcomer = await makeUser(ctx.sql);
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const links = [1, 2, 3].map((n) => ({ type: 'text' as const, text: ` link ${n}`, href: `https://site${n}.example` }));
    const held = await createStory(newcomer.headers, {
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A crowd gathered in the square and stayed there for days.' }, ...links] }],
    });
    expect(held.status).toBe('pending');
    // The author can see their own held story; nobody else.
    expect((await get(`/api/stories/${held.storyId}`, newcomer.headers)).status).toBe(200);
    expect((await get(`/api/stories/${held.storyId}`)).status).toBe(404);

    expect((await post(`/api/revisions/${held.revisionId}/review`, reviewer.headers, { decision: 'accept' })).statusCode).toBe(200);
    expect((await get<StoryDetail>(`/api/stories/${held.storyId}`)).body.status).toBe('active');
  });

  it('only counts published stories toward promotion', async () => {
    const newcomer = await makeUser(ctx.sql, { ageDays: 10 });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createStory(newcomer.headers, { title: `Draft story number ${i}` })).storyId);
    expect((await get<{ user: { trustLevel: number } }>('/api/session', newcomer.headers)).body.user.trustLevel).toBe(TRUST.NEW);

    for (const id of ids) {
      const revisionId = (await get<StoryDetail>(`/api/stories/${id}`, reviewer.headers)).body.revision.id;
      await post(`/api/stories/${id}/status`, reviewer.headers, { status: 'active', revisionId });
    }
    expect((await get<{ user: { trustLevel: number } }>('/api/session', newcomer.headers)).body.user.trustLevel).toBe(TRUST.MEMBER);
  });

  it('applies the member daily limits', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    expect(RULES.storiesPerDay[TRUST.MEMBER]).toBe(10);
    expect(RULES.editsPerDay[TRUST.MEMBER]).toBe(20);
    const results = await Promise.all(Array.from({ length: 12 }, () => post('/api/stories', member.headers, storyInput())));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(10);
  });
});

describe('user pages and contributions', () => {
  it('shows basics to everyone and contributions only to the user and reviewers', async () => {
    const author = await makeUser(ctx.sql);
    const other = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = await createStory(author.headers, { title: 'Contribution page story' });

    const anon = (await get<UserProfile>(`/api/users/${author.id}`)).body;
    expect(anon).toMatchObject({ id: author.id, trustLevel: TRUST.NEW, details: null, moderation: null });

    const self = (await get<UserProfile>(`/api/users/${author.id}`, author.headers)).body;
    expect(self.details?.stats).toMatchObject({ storiesStarted: 1, storiesLive: 0, edits: 1 });
    expect(self.details?.today).toMatchObject({ stories: 1, storiesLimit: RULES.storiesPerDay[0], editsLimit: RULES.editsPerDay[0] });
    expect(self.details?.progress.next).toMatchObject({ level: TRUST.MEMBER, minStories: RULES.promotion.member.minStories });
    expect(self.moderation).toBeNull();
    expect((await get<UserProfile>(`/api/users/${author.id}`, reviewer.headers)).body.moderation).toMatchObject({ banned: null, banRequests: [] });

    const stories = await get<Page<ContributionStory>>(`/api/users/${author.id}/stories`, author.headers);
    expect(stories.body.items[0]).toMatchObject({ state: 'waiting', story: { id: storyId, title: 'Contribution page story' } });
    const edits = await get<Page<ContributionEdit>>(`/api/users/${author.id}/revisions`, reviewer.headers);
    expect(edits.body.items[0]).toMatchObject({ storyId, isFirst: true, isCurrent: true, status: 'accepted', removed: false });

    expect((await get(`/api/users/${author.id}/stories`, other.headers)).status).toBe(403);
    expect((await get(`/api/users/${author.id}/revisions`)).status).toBe(401);
  });

  it('accepts reports about people and versions', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const target = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { revisionId } = await createStory(target.headers);
    for (const [targetType, targetId] of [['user', target.id], ['revision', revisionId]]) {
      expect((await post('/api/reports', member.headers, { targetType, targetId, reason: 'harassment' })).statusCode).toBe(201);
    }
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const rows = (await get<Page<ModUserRow>>(`/api/moderation/users?filter=reported&q=${encodeURIComponent(`User`)}`, mod.headers)).body.items;
    expect(rows.find((r) => r.id === target.id)?.openReports).toBe(2);
  });
});

describe('reports', () => {
  it('closes reports about a chat message when a reviewer hides it', async () => {
    const author = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reporter = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const [message] = await ctx.sql<{ id: string }[]>`
      INSERT INTO comments (cell, user_id, body) VALUES (${PARIS}, ${author.id}, 'a nasty message') RETURNING id`;
    await post('/api/reports', reporter.headers, { targetType: 'comment', targetId: message!.id, reason: 'harassment' });
    expect((await post(`/api/messages/${message!.id}/hide`, reviewer.headers)).statusCode).toBe(200);
    const tower = (await get<{ reports: { targetId: string }[] }>('/api/watchtower', reviewer.headers)).body;
    expect(tower.reports.some((r) => r.targetId === message!.id)).toBe(false);
  });
});

describe('removing versions from the history', () => {
  it("lets reviewers remove an old version, which can't then be viewed or restored", async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const { storyId, revisionId: first } = await createStory(member.headers, { title: 'Contains a home address' });
    const second = (await editStory(member.headers, storyId, { title: 'Address taken out now' })).json().revisionId;

    const current = await post(`/api/revisions/${second}/removed`, reviewer.headers, { removed: true });
    expect(current.statusCode).toBe(409);
    expect((await post(`/api/revisions/${first}/removed`, member.headers, { removed: true })).statusCode).toBe(403);
    expect((await post(`/api/revisions/${first}/removed`, reviewer.headers, { removed: true, reason: 'doxxing' })).statusCode).toBe(200);

    expect((await get(`/api/revisions/${first}`)).status).toBe(404);
    expect((await get(`/api/revisions/${first}`, member.headers)).status).toBe(404);
    expect((await get(`/api/revisions/${first}`, reviewer.headers)).status).toBe(200);
    const publicList = (await get<RevisionListItem[]>(`/api/stories/${storyId}/revisions`)).body;
    expect(publicList.map((r) => r.id)).toEqual([second]);
    const restore = await post(`/api/stories/${storyId}/restore`, mod.headers, { revisionId: first });
    expect(restore.statusCode).toBe(404);

    // Only moderators can put a version back.
    expect((await post(`/api/revisions/${first}/removed`, reviewer.headers, { removed: false })).statusCode).toBe(403);
    expect((await post(`/api/revisions/${first}/removed`, mod.headers, { removed: false })).statusCode).toBe(200);
    expect((await get(`/api/revisions/${first}`)).status).toBe(200);
  });
});

describe('levels', () => {
  it('lets moderators promote and demote, which pauses automatic promotion until handed back', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const user = await makeUser(ctx.sql, { ageDays: 10 });
    const level = async () => (await get<UserProfile>(`/api/users/${user.id}`)).body.trustLevel;

    expect((await post(`/api/users/${user.id}/trust`, reviewer.headers, { level: 2 })).statusCode).toBe(403);
    expect((await post(`/api/users/${user.id}/trust`, mod.headers, { level: 3 })).statusCode).toBe(400);
    expect((await post(`/api/users/${mod.id}/trust`, mod.headers, { level: 0 })).statusCode).toBe(403);

    expect((await post(`/api/users/${user.id}/trust`, mod.headers, { level: 2, reason: 'trusted historian' })).statusCode).toBe(200);
    expect(await level()).toBe(TRUST.REVIEWER);
    expect((await post(`/api/users/${user.id}/trust`, mod.headers, { level: 0 })).statusCode).toBe(200);
    expect(await level()).toBe(TRUST.NEW);

    // They now qualify for Member, but a level set by a moderator stays put...
    // (Created as a Member so the stories are published, then back to the level the moderator set.)
    const ids: string[] = [];
    await ctx.sql`UPDATE users SET trust_level = 1 WHERE id = ${user.id}`;
    for (let i = 0; i < 3; i++) ids.push((await createStory(user.headers, { title: `Qualifying story ${i}` })).storyId);
    await ctx.sql`UPDATE users SET trust_level = 0 WHERE id = ${user.id}`;
    await refreshTrust(ctx.sql, user.id);
    expect(await level()).toBe(TRUST.NEW);

    // ...until it is handed back to the automatic rules.
    expect((await post(`/api/users/${user.id}/trust`, mod.headers, { level: 'auto' })).statusCode).toBe(200);
    expect(await level()).toBe(TRUST.MEMBER);
    const self = (await get<UserProfile>(`/api/users/${user.id}`, user.headers)).body;
    expect(self.details?.trustLocked).toBe(false);
  });

  it('takes moderator access away from anyone no longer in ADMIN_EMAILS', async () => {
    const formerMod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    await ctx.sql`UPDATE users SET email = 'former@example.com' WHERE id = ${formerMod.id}`;
    const session = (await get<{ user: { trustLevel: number } }>('/api/session', formerMod.headers)).body;
    expect(session.user.trustLevel).toBe(TRUST.REVIEWER);
    expect((await get('/api/moderation/users', formerMod.headers)).status).toBe(403);

    // Signing in stores it; being listed restores it.
    const [row] = await ctx.sql<{ googleSub: string }[]>`SELECT google_sub FROM users WHERE id = ${formerMod.id}`;
    const googleSub = row!.googleSub;
    await upsertGoogleUser(ctx.sql, testConfig(), { sub: googleSub, email: 'former@example.com' });
    expect((await ctx.sql<{ trustLevel: number }[]>`SELECT trust_level FROM users WHERE id = ${formerMod.id}`)[0]!.trustLevel).toBe(TRUST.REVIEWER);
    await upsertGoogleUser(ctx.sql, testConfig(), { sub: googleSub, email: MODERATOR_EMAIL });
    expect((await ctx.sql<{ trustLevel: number }[]>`SELECT trust_level FROM users WHERE id = ${formerMod.id}`)[0]!.trustLevel).toBe(TRUST.MODERATOR);
  });
});

describe('ban requests and bans', () => {
  it('lets reviewers ask for a ban, which moderators can decline', async () => {
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const troll = await makeUser(ctx.sql);

    expect((await post(`/api/users/${troll.id}/ban-requests`, member.headers, { reason: 'posting spam everywhere' })).statusCode).toBe(403);
    expect((await post(`/api/users/${troll.id}/ban-requests`, reviewer.headers, { reason: 'no' })).statusCode).toBe(400);
    expect((await post(`/api/users/${troll.id}/ban-requests`, reviewer.headers, { reason: 'posting spam everywhere' })).statusCode).toBe(201);
    expect((await post(`/api/users/${troll.id}/ban-requests`, reviewer.headers, { reason: 'again please' })).statusCode).toBe(409);
    expect((await post(`/api/users/${mod.id}/ban-requests`, reviewer.headers, { reason: 'abusing powers' })).statusCode).toBe(403);

    expect((await get('/api/moderation/ban-requests', reviewer.headers)).status).toBe(403);
    const queue = (await get<BanRequestGroup[]>('/api/moderation/ban-requests', mod.headers)).body;
    const group = queue.find((g) => g.user.id === troll.id);
    expect(group?.requests).toMatchObject([{ reason: 'posting spam everywhere', requestedBy: { id: reviewer.id } }]);
    expect(group?.user.openBanRequests).toBe(1);

    expect((await post(`/api/users/${troll.id}/ban-requests/decline`, mod.headers, { reason: 'warned instead' })).statusCode).toBe(200);
    expect((await get<BanRequestGroup[]>('/api/moderation/ban-requests', mod.headers)).body.some((g) => g.user.id === troll.id)).toBe(false);
    expect((await post(`/api/users/${troll.id}/ban-requests/decline`, mod.headers, {})).statusCode).toBe(404);
  });

  it('bans while keeping posts: signed out, blocked, requests and reports settled, stories stay', async () => {
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const target = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId } = await createStory(target.headers);
    await post(`/api/users/${target.id}/ban-requests`, reviewer.headers, { reason: 'harassing people in chat' });
    await post('/api/reports', reviewer.headers, { targetType: 'user', targetId: target.id, reason: 'harassment' });

    expect((await post(`/api/users/${target.id}/ban`, reviewer.headers, { banned: true })).statusCode).toBe(403);
    const ban = await post(`/api/users/${target.id}/ban`, mod.headers, { banned: true, reason: 'harassment', removeContent: false });
    expect(ban.json()).toMatchObject({ ok: true, cleanup: null });

    expect((await get<{ user: null }>('/api/session', target.headers)).body.user).toBeNull();
    expect((await get(`/api/stories/${storyId}`)).status).toBe(200);
    expect((await get<BanRequestGroup[]>('/api/moderation/ban-requests', mod.headers)).body.some((g) => g.user.id === target.id)).toBe(false);
    const profile = (await get<UserProfile>(`/api/users/${target.id}`, mod.headers)).body;
    expect(profile.moderation).toMatchObject({ banned: { reason: 'harassment' }, openReports: 0, banRequests: [] });
    expect((await post(`/api/users/${target.id}/ban`, mod.headers, { banned: true })).statusCode).toBe(409);

    expect((await post(`/api/users/${target.id}/ban`, mod.headers, { banned: false })).statusCode).toBe(200);
    expect((await get<UserProfile>(`/api/users/${target.id}`, mod.headers)).body.moderation?.banned).toBeNull();
  });

  it('bans and removes posts: hides their stories, rolls back their edits, and removes their versions for good', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const good = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const troll = await makeUser(ctx.sql, { trust: TRUST.MEMBER, ageDays: 1 });
    const reporter = await makeUser(ctx.sql, { trust: TRUST.MEMBER });

    const own = await createStory(troll.headers, { title: 'A troll story to remove' });
    const victim = await createStory(good.headers, { title: 'A good story by someone' });
    const vandalism = (await editStory(troll.headers, victim.storyId, { title: 'Vandalised by the troll' })).json().revisionId;
    const onlyTroll = await createStory(good.headers, { title: 'Second good story' });
    // A story whose every accepted version is the troll's except a removed one has nothing to fall back to.
    await editStory(troll.headers, onlyTroll.storyId, { title: 'Troll edit on second story' });
    await ctx.sql`UPDATE story_revisions SET hidden_at = now() WHERE id = ${onlyTroll.revisionId}`;
    const third = await createStory(good.headers, { title: 'Third good story here', body: 'A long and careful account of what happened. '.repeat(20) });
    const held = (await editStory(troll.headers, third.storyId, { body: 'Nothing happened here at all, this is all fake.' })).json();
    expect(held.status).toBe('pending');
    await ctx.sql`INSERT INTO comments (cell, user_id, body) VALUES (${PARIS}, ${troll.id}, 'a rude message')`;
    await post('/api/reports', troll.headers, { targetType: 'story', targetId: victim.storyId, reason: 'spam' });
    await post('/api/reports', reporter.headers, { targetType: 'story', targetId: own.storyId, reason: 'vandalism' });

    const ban = await post(`/api/users/${troll.id}/ban`, mod.headers, { banned: true, reason: 'vandalism spree', removeContent: true });
    expect(ban.statusCode).toBe(200);
    expect(ban.json().cleanup).toEqual({
      storiesHidden: 2, // their own story + the one with nothing to fall back to
      storiesRolledBack: 1,
      editsRejected: 1,
      versionsRemoved: 4,
      messagesHidden: 1,
      reportsClosed: 2,
    });

    expect((await get(`/api/stories/${own.storyId}`)).status).toBe(404);
    expect((await get(`/api/stories/${onlyTroll.storyId}`)).status).toBe(404);
    const rolledBack = (await get<StoryDetail>(`/api/stories/${victim.storyId}`)).body;
    expect(rolledBack.revision.title).toBe('A good story by someone');
    expect(rolledBack.revision.author.id).toBe(mod.id);
    expect((await get(`/api/revisions/${vandalism}`)).status).toBe(404);
    expect((await post(`/api/stories/${victim.storyId}/restore`, mod.headers, { revisionId: vandalism })).statusCode).toBe(404);
    expect((await get<StoryDetail>(`/api/stories/${third.storyId}`)).body.pendingCount).toBe(0);
    const hidden = await ctx.sql`SELECT 1 FROM comments WHERE user_id = ${troll.id} AND hidden_at IS NULL`;
    expect(hidden).toHaveLength(0);

    // Unbanning doesn't bring removed content back.
    await post(`/api/users/${troll.id}/ban`, mod.headers, { banned: false });
    expect((await get(`/api/stories/${own.storyId}`)).status).toBe(404);

    const log = (await get<Page<AuditEntry>>(`/api/moderation/log?targetType=user&targetId=${troll.id}`, mod.headers)).body.items;
    expect(log.map((e) => e.action)).toEqual(['unban', 'ban']);
    expect(log[1]).toMatchObject({ reason: 'vandalism spree', details: { removeContent: true, storiesRolledBack: 1 }, target: { userId: troll.id } });
    const rollback = (await get<Page<AuditEntry>>(`/api/moderation/log?action=rollback&targetId=${victim.storyId}`, mod.headers)).body.items;
    expect(rollback[0]).toMatchObject({ actor: { id: mod.id }, target: { storyId: victim.storyId, label: 'A good story by someone' } });
  });

  it('can remove the posts of someone already banned', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const target = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId } = await createStory(target.headers);
    await post(`/api/users/${target.id}/ban`, mod.headers, { banned: true });
    const cleanup = await post(`/api/users/${target.id}/ban`, mod.headers, { banned: true, removeContent: true });
    expect(cleanup.json().cleanup).toMatchObject({ storiesHidden: 1 });
    expect((await get(`/api/stories/${storyId}`)).status).toBe(404);
  });
});

describe('deleting accounts', () => {
  it('lets moderators delete an account, with or without its posts', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const keep = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const remove = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const kept = await createStory(keep.headers);
    const removed = await createStory(remove.headers);

    expect((await post(`/api/users/${keep.id}/delete`, reviewer.headers, { removeContent: false })).statusCode).toBe(403);
    expect((await post(`/api/users/${mod.id}/delete`, mod.headers, { removeContent: false })).statusCode).toBe(403);

    expect((await post(`/api/users/${keep.id}/delete`, mod.headers, { removeContent: false, reason: 'asked by email' })).statusCode).toBe(200);
    expect((await get<{ user: null }>('/api/session', keep.headers)).body.user).toBeNull();
    expect((await get<StoryDetail>(`/api/stories/${kept.storyId}`)).body.revision.author.displayName).toBe('Deleted user');
    expect((await get<UserProfile>(`/api/users/${keep.id}`)).body).toMatchObject({ deleted: true, displayName: 'Deleted user' });

    const res = await post(`/api/users/${remove.id}/delete`, mod.headers, { removeContent: true });
    expect(res.json().cleanup).toMatchObject({ storiesHidden: 1, versionsRemoved: 1 });
    expect((await get(`/api/stories/${removed.storyId}`)).status).toBe(404);
    expect((await post(`/api/users/${remove.id}/delete`, mod.headers, { removeContent: true })).statusCode).toBe(404);

    const users = (await get<Page<ModUserRow>>('/api/moderation/users', mod.headers)).body.items.map((u) => u.id);
    expect(users).not.toContain(keep.id);
  });
});

describe('moderator screens', () => {
  it('lists and filters users and the audit log for moderators only', async () => {
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    await ctx.sql`UPDATE users SET display_name = 'Zebra_100%' WHERE id = ${reviewer.id}`;

    expect((await get('/api/moderation/users', reviewer.headers)).status).toBe(403);
    expect((await get('/api/moderation/log', reviewer.headers)).status).toBe(403);

    const byName = (await get<Page<ModUserRow>>(`/api/moderation/users?q=${encodeURIComponent('bra_100%')}`, mod.headers)).body.items;
    expect(byName.map((u) => u.id)).toEqual([reviewer.id]);
    // LIKE wildcards in the search are literal.
    expect((await get<Page<ModUserRow>>(`/api/moderation/users?q=${encodeURIComponent('Z%a')}`, mod.headers)).body.items).toEqual([]);
    const reviewers = (await get<Page<ModUserRow>>('/api/moderation/users?level=2', mod.headers)).body.items;
    expect(reviewers.every((u) => u.trustLevel === TRUST.REVIEWER)).toBe(true);

    const log = await get<Page<AuditEntry>>('/api/moderation/log', mod.headers);
    expect(log.status).toBe(200);
    expect(log.body.items.length).toBeGreaterThan(0);
    const byActor = (await get<Page<AuditEntry>>(`/api/moderation/log?actorId=${mod.id}`, mod.headers)).body.items;
    expect(byActor).toEqual([]);
  });
});
