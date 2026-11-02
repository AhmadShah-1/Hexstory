import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellToParent } from 'h3-js';
import { LIMITS, TRUST, type StoryDetail, type StorySummary } from '@hexstory/shared';
import { createLocalStorage, type Storage } from '../src/storage/index.js';
import { ORIGIN, PARIS, buildTestApp, makeUser, setup, storyInput, uploadBytes } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

const createStory = async (headers: Record<string, string>, overrides: Parameters<typeof storyInput>[0] = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/stories', headers, payload: storyInput(overrides) });

const getStory = async (id: string, headers: Record<string, string> = {}) =>
  (await ctx.app.inject({ url: `/api/stories/${id}`, headers })).json<StoryDetail>();

describe('session & access', () => {
  it('reports an anonymous session with sign-in disabled when Google is not configured', async () => {
    const res = await ctx.app.inject({ url: '/api/session' });
    expect(res.json()).toEqual({ user: null, signInEnabled: false });
  });

  it('rejects writes from anonymous users and from other origins', async () => {
    expect((await createStory({ origin: ORIGIN })).statusCode).toBe(401);
    const user = await makeUser(ctx.sql);
    expect((await createStory({ ...user.headers, origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('requires accepting the terms before contributing', async () => {
    const user = await makeUser(ctx.sql, { termsAccepted: false });
    const blocked = await createStory(user.headers);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('terms-required');

    await ctx.app.inject({ method: 'PATCH', url: '/api/me', headers: user.headers, payload: { acceptTerms: true } });
    expect((await createStory(user.headers)).statusCode).toBe(201);
  });
});

describe('stories', () => {
  it('requires at least one source and an http(s) link', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    expect((await createStory(user.headers, { sources: [] })).statusCode).toBe(400);
    const badLink = await createStory(user.headers, { sources: [{ title: 'x', url: 'javascript:alert(1)' }] });
    expect(badLink.statusCode).toBe(400);
  });

  it('indexes a story under every zoom level and orders lists by event date', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const cell = cellToParent(PARIS, 3);
    await createStory(user.headers, { title: 'Old event here', start: { year: -52 } });
    await createStory(user.headers, { title: 'Recent event here', start: { year: 1968, month: 5 } });
    await createStory(user.headers, { title: 'Ongoing event here', start: { year: 1900 }, isOngoing: true });

    const list = (await ctx.app.inject({ url: `/api/cells/${cell}/stories` })).json<{ items: StorySummary[] }>();
    const titles = list.items.map((s) => s.title);
    expect(titles.indexOf('Ongoing event here')).toBeLessThan(titles.indexOf('Recent event here'));
    expect(titles.indexOf('Recent event here')).toBeLessThan(titles.indexOf('Old event here'));
    expect(list.items[0]!.sourceCount).toBe(1);

    const points = (await ctx.app.inject({ url: '/api/map/points' })).json<{ title: string }[]>();
    expect(points.filter((p) => p.title.endsWith('event here'))).toHaveLength(3);
  });

  it('stores multi-hex stories compactly and counts their base cells', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const res = await createStory(user.headers, { cells: [cellToParent(PARIS, 3)] });
    const story = await getStory(res.json().storyId);
    expect(story.cellCount).toBe(49);
    expect(story.revision.cells).toEqual([cellToParent(PARIS, 3)]);
  });
});

describe('anti-vandalism', () => {
  it("holds a newcomer's edit to someone else's story until a reviewer accepts it", async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const newcomer = await makeUser(ctx.sql);
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = (await createStory(member.headers)).json();
    const original = await getStory(storyId);

    const edit = await ctx.app.inject({
      method: 'PUT',
      url: `/api/stories/${storyId}`,
      headers: newcomer.headers,
      payload: { ...storyInput({ title: 'A newcomer improved title' }), baseRevisionId: original.revision.id },
    });
    expect(edit.json().status).toBe('pending');
    expect((await getStory(storyId)).revision.title).toBe(original.revision.title);
    expect((await getStory(storyId)).pendingCount).toBe(1);

    const selfReview = await ctx.app.inject({
      method: 'POST',
      url: `/api/revisions/${edit.json().revisionId}/review`,
      headers: newcomer.headers,
      payload: { decision: 'accept' },
    });
    expect(selfReview.statusCode).toBe(403);

    const accept = await ctx.app.inject({
      method: 'POST',
      url: `/api/revisions/${edit.json().revisionId}/review`,
      headers: reviewer.headers,
      payload: { decision: 'accept' },
    });
    expect(accept.statusCode).toBe(200);
    expect((await getStory(storyId)).revision.title).toBe('A newcomer improved title');
  });

  it('rejects edits based on an outdated version', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId } = (await createStory(member.headers)).json();
    const base = (await getStory(storyId)).revision.id;
    const put = (title: string) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/stories/${storyId}`,
        headers: member.headers,
        payload: { ...storyInput({ title }), baseRevisionId: base },
      });
    expect((await put('First change wins')).json().status).toBe('live');
    const stale = await put('Second change loses');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stale');
  });

  it('holds large removals for review even from members, and reviewers can restore old versions', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const vandal = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const longBody = 'A long and careful account of what happened. '.repeat(20);
    const { storyId } = (await createStory(member.headers, { body: longBody })).json();
    const original = await getStory(storyId);

    const blanking = await ctx.app.inject({
      method: 'PUT',
      url: `/api/stories/${storyId}`,
      headers: vandal.headers,
      payload: { ...storyInput({ body: 'Nothing happened here at all, this is all fake.' }), baseRevisionId: original.revision.id },
    });
    expect(blanking.json().status).toBe('pending');

    // A member edit that does go live can be undone by restoring the earlier version.
    const vandalism = await ctx.app.inject({
      method: 'PUT',
      url: `/api/stories/${storyId}`,
      headers: vandal.headers,
      payload: { ...storyInput({ body: longBody, title: 'Vandalised title' }), baseRevisionId: original.revision.id },
    });
    expect(vandalism.json().status).toBe('live');
    const restore = await ctx.app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/restore`,
      headers: reviewer.headers,
      payload: { revisionId: original.revision.id },
    });
    expect(restore.statusCode).toBe(200);
    const restored = await getStory(storyId);
    expect(restored.revision.title).toBe(original.revision.title);
    expect(restored.revision.id).not.toBe(original.revision.id);
  });

  it('limits how many stories a newcomer can create per day', async () => {
    const newcomer = await makeUser(ctx.sql);
    for (let i = 0; i < 3; i++) expect((await createStory(newcomer.headers)).statusCode).toBe(201);
    expect((await createStory(newcomer.headers)).statusCode).toBe(429);
  });

  it('hides stories from the public once a reviewer hides them', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = (await createStory(member.headers)).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/status`,
      headers: reviewer.headers,
      payload: { status: 'hidden' },
    });
    expect((await ctx.app.inject({ url: `/api/stories/${storyId}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/api/stories/${storyId}`, headers: reviewer.headers })).statusCode).toBe(200);
  });
});

describe('moderation', () => {
  it('lets anyone signed in report, and only reviewers open the Watchtower', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = (await createStory(member.headers)).json();
    const report = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/reports',
        headers: member.headers,
        payload: { targetType: 'story', targetId: storyId, reason: 'spam' },
      });
    expect((await report()).statusCode).toBe(201);
    expect((await report()).statusCode).toBe(409);

    expect((await ctx.app.inject({ url: '/api/watchtower', headers: member.headers })).statusCode).toBe(403);
    const tower = await ctx.app.inject({ url: '/api/watchtower', headers: reviewer.headers });
    expect(tower.json().reports.some((r: { targetId: string }) => r.targetId === storyId)).toBe(true);
  });
});

describe('rich content', () => {
  const words = 'A crowd gathered in the square and stayed there for eighteen days.';

  it('stores links and images, and makes the first image the thumbnail', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const imageKey = await uploadTestImage(user.headers);
    const content = [
      { type: 'image' as const, key: imageKey, caption: 'The square at dusk' },
      { type: 'paragraph' as const, content: [
        { type: 'text' as const, text: words },
        { type: 'text' as const, text: ' Read more', href: 'https://example.org/report', bold: true },
      ] },
      { type: 'list' as const, ordered: false, items: [[{ type: 'text' as const, text: 'First day' }]] },
    ];
    const res = await createStory(user.headers, { content });
    expect(res.statusCode).toBe(201);
    const story = await getStory(res.json().storyId);
    expect(story.revision.content[0]).toMatchObject({ type: 'image', key: imageKey, url: `/media/${imageKey}.webp` });
    expect(story.revision.thumbUrl).toBe(`/media/${imageKey}-thumb.webp`);
    expect(story.revision.body).toContain('[Image: The square at dusk]');
  });

  it('rejects script links, unknown images and unexpected block types', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const para = (extra: object) => [{ type: 'paragraph', content: [{ type: 'text', text: words, ...extra }] }];
    expect((await createStory(user.headers, { content: para({ href: 'javascript:alert(1)' }) as never })).statusCode).toBe(400);
    const missing = [...para({}), { type: 'image', key: '00000000-0000-4000-8000-000000000000', caption: null }];
    expect((await createStory(user.headers, { content: missing as never })).statusCode).toBe(400);
    const html = [...para({}), { type: 'html', html: '<script>alert(1)</script>' }];
    expect((await createStory(user.headers, { content: html as never })).statusCode).toBe(400);
  });

  it('counts linked text toward the newcomer link limit', async () => {
    const newcomer = await makeUser(ctx.sql);
    const links = [1, 2, 3].map((n) => ({ type: 'text' as const, text: ` link ${n}`, href: `https://spam${n}.example` }));
    const res = await createStory(newcomer.headers, { content: [{ type: 'paragraph', content: [{ type: 'text', text: words }, ...links] }] });
    expect(res.json().status).toBe('pending');
  });
});

describe('uploads', () => {
  it('re-encodes images to WebP, strips metadata and discards the original', async () => {
    const user = await makeUser(ctx.sql);
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c66' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-location' } } })
      .jpeg()
      .toBuffer();
    const { ticket, put, done } = await uploadBytes(ctx.app, user.headers, jpeg);
    expect(put.statusCode).toBe(200);
    expect(done.statusCode).toBe(201);
    const { imageKey } = done.json();
    expect(imageKey).toBe(ticket.id);
    const file = join(ctx.uploadDir, `${imageKey}.webp`);
    expect(existsSync(file)).toBe(true);
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(existsSync(join(`${ctx.uploadDir}-staging`, user.id, ticket.id))).toBe(false);
  });

  it('rejects files that are not images', async () => {
    const user = await makeUser(ctx.sql);
    const { done } = await uploadBytes(ctx.app, user.headers, Buffer.from('<script>alert(1)</script>'));
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toBe('bad-image');
  });

  it('refuses originals over the size limit before handing out an upload URL', async () => {
    const user = await makeUser(ctx.sql);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: user.headers, payload: { size: LIMITS.imageBytesMax + 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("never lets a user complete someone else's upload, and completes each upload once", async () => {
    const owner = await makeUser(ctx.sql);
    const other = await makeUser(ctx.sql);
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } }).jpeg().toBuffer();
    const ticket = (await ctx.app.inject({ method: 'POST', url: '/api/uploads', headers: owner.headers, payload: { size: jpeg.length } })).json();
    await ctx.app.inject({ method: 'PUT', url: ticket.upload.url, headers: { ...owner.headers, ...ticket.upload.headers }, payload: jpeg });

    const stolen = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${ticket.id}/complete`, headers: other.headers, payload: {} });
    expect(stolen.statusCode).toBe(404);
    const done = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${ticket.id}/complete`, headers: owner.headers, payload: {} });
    expect(done.statusCode).toBe(201);
    const again = await ctx.app.inject({ method: 'POST', url: `/api/uploads/${ticket.id}/complete`, headers: owner.headers, payload: {} });
    expect(again.statusCode).toBe(404);
  });

  it('reports a storage failure instead of success and leaves no half-published image', async () => {
    const user = await makeUser(ctx.sql);
    const storage = createLocalStorage(ctx.uploadDir);
    const deleted: string[] = [];
    let puts = 0;
    const failing: Storage = {
      ...storage,
      put: async (name, data, type) => {
        // The thumbnail write fails after the full-size image was written.
        if (++puts === 2) throw new Error('R2 upload of thumb failed with HTTP 500');
        await storage.put(name, data, type);
      },
      delete: async (name) => {
        deleted.push(name);
        await storage.delete(name);
      },
    };
    const app = await buildTestApp(ctx.sql, { storage: failing });
    try {
      const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } }).jpeg().toBuffer();
      const { ticket, done } = await uploadBytes(app, user.headers, jpeg);
      expect(done.statusCode).toBe(502);
      expect(deleted.sort()).toEqual([`${ticket.id}-thumb.webp`, `${ticket.id}.webp`]);
      expect(existsSync(join(ctx.uploadDir, `${ticket.id}.webp`))).toBe(false);
      // The original is kept so the browser can retry the last step.
      expect(existsSync(join(`${ctx.uploadDir}-staging`, user.id, ticket.id))).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('account deletion', () => {
  it('anonymizes the user but keeps their contributions', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId } = (await createStory(user.headers)).json();
    await ctx.app.inject({ method: 'DELETE', url: '/api/me', headers: user.headers });
    expect((await ctx.app.inject({ url: '/api/session', headers: user.headers })).json().user).toBeNull();
    expect((await getStory(storyId)).revision.author.displayName).toBe('Deleted user');
  });
});

describe('security regressions', () => {
  it('rejects huge areas before expanding them', async () => {
    const user = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { getRes0Cells, cellToChildren } = await import('h3-js');
    const coarse = getRes0Cells().flatMap((c) => cellToChildren(c, 2)).slice(0, 5000);
    const started = Date.now();
    const res = await createStory(user.headers, { cells: coarse });
    expect(res.statusCode).toBe(400);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('only shows unaccepted versions to reviewers and their author', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const newcomer = await makeUser(ctx.sql);
    const { storyId } = (await createStory(member.headers)).json();
    const base = (await getStory(storyId)).revision.id;
    const { revisionId } = (
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/stories/${storyId}`,
        headers: newcomer.headers,
        payload: { ...storyInput({ title: 'Doxxing attempt here' }), baseRevisionId: base, editSummary: 'abusive summary' },
      })
    ).json();
    expect((await ctx.app.inject({ url: `/api/revisions/${revisionId}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: `/api/revisions/${revisionId}`, headers: newcomer.headers })).statusCode).toBe(200);
    const list = (await ctx.app.inject({ url: `/api/stories/${storyId}/revisions` })).json<{ id: string }[]>();
    expect(list.map((r) => r.id)).not.toContain(revisionId);
  });

  it('does not let reviewers restore pending versions or bypass protection', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const mod = await makeUser(ctx.sql, { trust: TRUST.MODERATOR });
    const { storyId } = (await createStory(member.headers)).json();
    await ctx.app.inject({ method: 'POST', url: `/api/stories/${storyId}/protection`, headers: mod.headers, payload: { level: 3 } });
    const base = (await getStory(storyId)).revision.id;
    const held = await ctx.app.inject({
      method: 'PUT',
      url: `/api/stories/${storyId}`,
      headers: reviewer.headers,
      payload: { ...storyInput({ title: 'Reviewer wants this live' }), baseRevisionId: base },
    });
    expect(held.json().status).toBe('pending');
    const restore = await ctx.app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/restore`,
      headers: reviewer.headers,
      payload: { revisionId: held.json().revisionId },
    });
    expect(restore.statusCode).toBe(403);
  });

  it('cannot farm trust by repeatedly editing your own story', async () => {
    const farmer = await makeUser(ctx.sql, { trust: TRUST.MEMBER, ageDays: 60 });
    const { storyId } = (await createStory(farmer.headers)).json();
    for (let i = 0; i < 30; i++) {
      const base = (await getStory(storyId)).revision.id;
      await ctx.app.inject({
        method: 'PUT',
        url: `/api/stories/${storyId}`,
        headers: farmer.headers,
        payload: { ...storyInput({ title: `Edit number ${i}` }), baseRevisionId: base },
      });
    }
    const session = (await ctx.app.inject({ url: '/api/session', headers: farmer.headers })).json();
    expect(session.user.trustLevel).toBe(TRUST.MEMBER);
  });

  it('enforces daily limits under parallel requests', async () => {
    const newcomer = await makeUser(ctx.sql);
    const results = await Promise.all(Array.from({ length: 10 }, () => createStory(newcomer.headers)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
  });

  it('only allows plain same-site return paths after sign-in', async () => {
    const { safeReturnTo } = await import('../src/auth/google.js');
    for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', 'https://evil.com', '/ /evil.com']) {
      expect(safeReturnTo(bad)).toBe('/');
    }
    expect(safeReturnTo('/h/831fb4fffffffff?tab=square')).toBe('/h/831fb4fffffffff?tab=square');
  });
});

async function uploadTestImage(headers: Record<string, string>): Promise<string> {
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#468' } }).jpeg().toBuffer();
  return (await uploadBytes(ctx.app, headers, jpeg)).done.json().imageKey;
}
