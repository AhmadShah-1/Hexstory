import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TRUST,
  cellAt,
  eventRange,
  type CollectionDetail,
  type Correction,
  type Development,
  type DiscoverData,
  type MapPoint,
  type Page,
  type StoryDetail,
  type StorySummary,
  type UserProfile,
  type WatchtowerData,
} from '@hexstory/shared';
import { makeUser, setup, storyInput } from './helpers.js';

/** Connected history: locations, links, timelines, corrections, collections, lists and discovery. */
let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

type Headers = Record<string, string>;
const get = <T>(path: string, headers: Headers = {}) => ctx.app.inject({ url: path, headers }).then((r) => ({ status: r.statusCode, body: r.json<T>(), headers: r.headers }));
const send = (method: 'POST' | 'PUT', path: string, headers: Headers, payload: object = {}) => ctx.app.inject({ method, url: path, headers, payload });
const post = (path: string, headers: Headers, payload: object = {}) => send('POST', path, headers, payload);
const create = async (headers: Headers, overrides: Parameters<typeof storyInput>[0] = {}) => {
  const res = await post('/api/stories', headers, storyInput(overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ storyId: string; revisionId: string }>();
};
const story = async (id: string, headers: Headers = {}) => (await get<StoryDetail>(`/api/stories/${id}`, headers)).body;
const edit = async (headers: Headers, id: string, overrides: Parameters<typeof storyInput>[0] = {}) =>
  send('PUT', `/api/stories/${id}`, headers, { ...storyInput(overrides), baseRevisionId: (await story(id, headers)).revision.id });
const titles = (page: Page<StorySummary>) => page.items.map((s) => s.title);
const source = [{ title: 'A newspaper report', url: 'https://example.org/report' }];

describe('precise locations and new story fields', () => {
  it('stores a point, summary, categories and people, and indexes a story without an area at its point', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId } = await create(member.headers, {
      title: 'A precise event in Lyon',
      location: { lat: 45.764, lng: 4.8357, placeName: 'Place Bellecour, Lyon' },
      cells: [],
      categories: ['culture', 'local'],
      people: ['Jane Doe', 'jane doe', 'John Roe'],
    });
    const detail = await story(storyId);
    expect(detail.revision).toMatchObject({
      location: { lat: 45.764, lng: 4.8357, placeName: 'Place Bellecour, Lyon' },
      categories: ['culture', 'local'],
      people: ['jane doe', 'John Roe'],
      cells: [cellAt(45.764, 4.8357, 5)],
    });
    expect(detail.point).toEqual({ lat: 45.764, lng: 4.8357 });
    expect(detail.cellCount).toBe(1);
    // Found in its hexagon even though no area was picked.
    const inCell = (await get<Page<StorySummary>>(`/api/cells/${cellAt(45.764, 4.8357, 3)}/stories`)).body;
    expect(titles(inCell)).toContain('A precise event in Lyon');
  });

  it('requires a summary, a category and a location', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    for (const bad of [{ summary: 'Too short' }, { categories: [] }, { location: undefined }, { categories: ['gossip'] }]) {
      const res = await post('/api/stories', member.headers, { ...storyInput(), ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('serves every published story as a map point, cacheable by the CDN', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const { storyId } = await create(member.headers, { title: 'A point on the map', start: { year: 1848 }, end: { year: 1849, month: 6 } });
    const res = await get<MapPoint[]>('/api/map/points');
    expect(res.headers['cache-control']).toMatch(/s-maxage=\d+/);
    const point = res.body.find((p) => p.id === storyId);
    expect(point).toMatchObject({ lat: 48.8532, lng: 2.3692, year: 1848, categories: ['protest'] });
    expect(point).toMatchObject(eventRange({ start: { year: 1848 }, end: { year: 1849, month: 6 }, isOngoing: false }));
    // A newcomer's unpublished story is not on the map.
    const newcomer = await makeUser(ctx.sql);
    const hidden = await create(newcomer.headers, { title: 'Not public yet at all' });
    expect((await get<MapPoint[]>('/api/map/points')).body.some((p) => p.id === hidden.storyId)).toBe(false);
  });
});

describe('connections between stories', () => {
  it('shows links on both stories with the inverse relation, and follows edits', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const cause = await create(member.headers, { title: 'The cause of it all' });
    const effect = await create(member.headers, { title: 'What came after', links: [{ storyId: cause.storyId, relation: 'preceded-by' }] });

    expect((await story(effect.storyId)).connections).toMatchObject([{ relation: 'preceded-by', direction: 'out', story: { id: cause.storyId } }]);
    expect((await story(cause.storyId)).connections).toMatchObject([{ relation: 'led-to', direction: 'in', story: { id: effect.storyId } }]);

    expect((await edit(member.headers, effect.storyId, { title: 'What came after', links: [] })).statusCode).toBe(200);
    expect((await story(cause.storyId)).connections).toEqual([]);
  });

  it("refuses links to itself and to someone else's unpublished story", async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const newcomer = await makeUser(ctx.sql);
    const draft = await create(newcomer.headers, { title: 'Private draft story' });
    const res = await post('/api/stories', member.headers, storyInput({ links: [{ storyId: draft.storyId, relation: 'related' }] }));
    expect(res.statusCode).toBe(400);
    const own = await create(member.headers, { title: 'Self-linking story' });
    expect((await edit(member.headers, own.storyId, { links: [{ storyId: own.storyId, relation: 'related' }] })).statusCode).toBe(400);
  });
});

describe('lists: filters and orderings', () => {
  it('filters by category, years, kind and person, and sorts by publication or connections', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const thisYear = new Date().getUTCFullYear();
    const old = await create(member.headers, { title: 'Ancient flood record', categories: ['disaster'], start: { year: 1300 }, people: ['Ada Lovelace'] });
    await create(member.headers, { title: 'A protest this year', categories: ['protest'], start: { year: thisYear } });
    await create(member.headers, { title: 'Linker one', links: [{ storyId: old.storyId, relation: 'preceded-by' }], start: { year: 1400 } });

    const disasters = (await get<Page<StorySummary>>('/api/stories?categories=disaster')).body;
    expect(titles(disasters)).toEqual(['Ancient flood record']);
    expect(disasters.items[0]).toMatchObject({ isHistorical: true, categories: ['disaster'] });

    const fourteenth = (await get<Page<StorySummary>>('/api/stories?from=1250&to=1350')).body;
    expect(titles(fourteenth)).toEqual(['Ancient flood record']);

    const fresh = titles((await get<Page<StorySummary>>('/api/stories?kind=new')).body);
    expect(fresh).toContain('A protest this year');
    expect(fresh).not.toContain('Ancient flood record');
    expect(titles((await get<Page<StorySummary>>('/api/stories?kind=historical')).body)).not.toContain('A protest this year');

    expect(titles((await get<Page<StorySummary>>(`/api/stories?person=${encodeURIComponent('ada lovelace')}`)).body)).toEqual(['Ancient flood record']);
    expect(titles((await get<Page<StorySummary>>('/api/stories?q=flood&sort=relevance')).body)[0]).toBe('Ancient flood record');
    expect(titles((await get<Page<StorySummary>>('/api/stories?sort=published')).body)[0]).toBe('Linker one');
    expect(titles((await get<Page<StorySummary>>('/api/stories?sort=significance')).body)[0]).toBe('Ancient flood record');
    expect((await get('/api/stories?sort=popularity')).status).toBe(400);
  });
});

describe('event timelines', () => {
  it('publishes members’ developments, holds newcomers’ for review, and marks the event as developing', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const newcomer = await makeUser(ctx.sql);
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = await create(member.headers, { title: 'A long crisis', start: { year: 2020 }, end: { year: 2021 } });
    const before = await story(storyId);

    const live = await post(`/api/stories/${storyId}/developments`, member.headers, {
      date: { year: 2020, month: 6 }, title: 'Talks break down', location: { lat: 46.2, lng: 6.15, placeName: 'Geneva' }, sources: source,
    });
    expect(live.json()).toMatchObject({ status: 'live' });
    const held = (await post(`/api/stories/${storyId}/developments`, newcomer.headers, { date: { year: 2020, month: 9 }, title: 'A newcomer adds this', sources: source })).json();
    expect(held.status).toBe('pending');

    const detail = await story(storyId);
    expect(detail.developments.map((d) => d.title)).toEqual(['Talks break down']);
    expect(detail.developmentCount).toBe(1);
    expect(new Date(detail.lastUpdateAt).getTime()).toBeGreaterThan(new Date(before.lastUpdateAt).getTime());
    expect((await get<Page<StorySummary>>('/api/stories?ongoing=1')).body.items.some((s) => s.id === storyId)).toBe(true);
    // Newcomers see their own held development; reviewers find it in the Watchtower.
    expect((await get<Page<Development>>(`/api/stories/${storyId}/developments`, newcomer.headers)).body.items).toHaveLength(2);
    const tower = (await get<WatchtowerData>('/api/watchtower', reviewer.headers)).body;
    expect(tower.developments.map((d) => d.id)).toContain(held.id);

    expect((await post(`/api/developments/${held.id}/review`, newcomer.headers, { decision: 'accept' })).statusCode).toBe(403);
    expect((await post(`/api/developments/${held.id}/review`, reviewer.headers, { decision: 'accept' })).statusCode).toBe(200);
    expect((await post(`/api/developments/${held.id}/review`, reviewer.headers, { decision: 'accept' })).statusCode).toBe(409);
    expect((await get<Page<Development>>(`/api/stories/${storyId}/developments`)).body.items.map((d) => d.title))
      .toEqual(['A newcomer adds this', 'Talks break down']);

    expect((await post(`/api/developments/${held.id}/remove`, reviewer.headers, { reason: 'duplicate' })).statusCode).toBe(200);
    expect((await get<Page<Development>>(`/api/stories/${storyId}/developments`)).body.items).toHaveLength(1);
  });
});

describe('corrections', () => {
  it('disputes a quoted statement, keeps the history, and records the outcome publicly', async () => {
    const author = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reader = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId, revisionId } = await create(author.headers, { title: 'A disputed account', body: 'The crowd numbered about one million people that day, according to organisers.' });
    const proposal = { revisionId, problem: 'inaccurate', proposal: 'Police counted about 200,000; organisers’ figures are disputed.', evidence: source };

    expect((await post(`/api/stories/${storyId}/corrections`, reader.headers, { ...proposal, quote: 'two million people' })).statusCode).toBe(400);
    const filed = await post(`/api/stories/${storyId}/corrections`, reader.headers, { ...proposal, quote: 'about one   million people' });
    expect(filed.statusCode).toBe(201);
    const { id } = filed.json<{ id: string }>();
    expect((await post(`/api/stories/${storyId}/corrections`, reader.headers, { ...proposal, quote: 'about one   million people' })).statusCode).toBe(409);
    expect((await story(storyId)).openCorrections).toBe(1);

    // Nobody decides their own correction or (unless a moderator) one about a story they started.
    expect((await post(`/api/corrections/${id}/resolve`, reader.headers, { decision: 'accepted', note: 'mine' })).statusCode).toBe(403);
    const fix = (await edit(author.headers, storyId, { title: 'A disputed account', body: 'Estimates of the crowd ranged from 200,000 (police) to one million (organisers).' })).json().revisionId;
    const resolved = await post(`/api/corrections/${id}/resolve`, reviewer.headers, { decision: 'accepted', note: 'Fixed with both estimates.', fixedRevisionId: fix });
    expect(resolved.statusCode).toBe(200);

    const list = (await get<Correction[]>(`/api/stories/${storyId}/corrections`)).body;
    expect(list[0]).toMatchObject({ status: 'accepted', stillInStory: false, resolution: { note: 'Fixed with both estimates.', fixedRevisionId: fix } });
    // The disputed version is still in the history.
    expect((await get(`/api/revisions/${revisionId}`)).status).toBe(200);
    // Accurate corrections are rewarded; the corrected story's author loses a little.
    const readerRep = (await get<UserProfile>(`/api/users/${reader.id}`, reader.headers)).body.details!.progress;
    expect(readerRep.breakdown.correctionsAccepted).toBe(1);
    expect(readerRep.others).toBe(1);
    const authorRep = (await get<UserProfile>(`/api/users/${author.id}`, author.headers)).body.details!.progress;
    expect(authorRep.breakdown.correctedStories).toBe(1);
  });
});

describe('reputation', () => {
  it('rewards quality, not volume: repeated edits to one story count once, rejected edits cost points', async () => {
    const editor = await makeUser(ctx.sql);
    const owner = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const { storyId } = await create(owner.headers, { title: 'A story others improve' });
    for (const title of ['Improved title one', 'Improved title two']) {
      const held = (await edit(editor.headers, storyId, { title })).json();
      await post(`/api/revisions/${held.revisionId}/review`, reviewer.headers, { decision: 'accept' });
    }
    const rejected = (await edit(editor.headers, storyId, { title: 'A bad change here' })).json();
    await post(`/api/revisions/${rejected.revisionId}/review`, reviewer.headers, { decision: 'reject' });
    const progress = (await get<UserProfile>(`/api/users/${editor.id}`, editor.headers)).body.details!.progress;
    expect(progress.breakdown).toMatchObject({ improvedStories: 1, editsRejected: 1, activeWeeks: 1 });
    expect(progress.reputation).toBe(3 + 1 - 2);
  });
});

describe('collections', () => {
  it('gathers stories by hand and by rules, and lists the collections a story belongs to', async () => {
    const newcomer = await makeUser(ctx.sql);
    const curator = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const other = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const rome = await create(curator.headers, { title: 'Something in Rome', location: { lat: 41.9, lng: 12.49 }, cells: [], start: { year: 80 }, categories: ['landmark'] });
    const picked = await create(curator.headers, { title: 'Picked by hand', start: { year: 1900 } });

    const body = {
      title: 'The history of Rome',
      description: 'Everything that happened in the eternal city, gathered automatically.',
      kind: 'place',
      cells: [cellAt(41.9, 12.49, 3)],
      items: [{ storyId: picked.storyId, note: 'Not in Rome, but related' }],
    };
    expect((await post('/api/collections', newcomer.headers, body)).statusCode).toBe(403);
    const res = await post('/api/collections', curator.headers, body);
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();

    const detail = (await get<CollectionDetail>(`/api/collections/${id}`)).body;
    expect(detail.items).toMatchObject([{ story: { id: picked.storyId }, note: 'Not in Rome, but related' }]);
    expect(detail.matched.map((s) => s.id)).toEqual([rome.storyId]);
    expect(detail.storyCount).toBe(2);
    expect((await story(rome.storyId)).collections).toMatchObject([{ id, kind: 'place' }]);

    expect((await send('PUT', `/api/collections/${id}`, other.headers, body)).statusCode).toBe(403);
    expect((await send('PUT', `/api/collections/${id}`, curator.headers, { ...body, title: 'Rome through the ages' })).statusCode).toBe(200);
    expect((await post(`/api/collections/${id}/status`, reviewer.headers, { status: 'hidden', reason: 'test' })).statusCode).toBe(200);
    expect((await get(`/api/collections/${id}`)).status).toBe(404);
    expect((await post(`/api/collections/${id}/status`, reviewer.headers, { status: 'active' })).statusCode).toBe(403);
  });
});

describe('discovery', () => {
  it('fills the home sections, features stories, and picks random ones', async () => {
    const member = await makeUser(ctx.sql, { trust: TRUST.MEMBER });
    const reviewer = await makeUser(ctx.sql, { trust: TRUST.REVIEWER });
    const today = await create(member.headers, { title: 'Happened on this very day', start: { year: 1950, month: 3, day: 7 } });
    const ongoing = await create(member.headers, { title: 'Still going on now', start: { year: 2024 }, isOngoing: true });

    expect((await post(`/api/stories/${today.storyId}/featured`, member.headers, { featured: true })).statusCode).toBe(403);
    expect((await post(`/api/stories/${today.storyId}/featured`, reviewer.headers, { featured: true })).statusCode).toBe(200);

    const home = await get<DiscoverData>('/api/discover?m=3&d=7');
    expect(home.headers['cache-control']).toMatch(/s-maxage/);
    expect(home.body.featured[0]?.id).toBe(today.storyId);
    expect(home.body.onThisDay.map((s) => s.id)).toContain(today.storyId);
    expect(home.body.developing.map((s) => s.id)).toContain(ongoing.storyId);
    expect(home.body.discoveries.map((s) => s.id)).toContain(today.storyId);
    expect(home.body.recent.map((s) => s.id)).toContain(ongoing.storyId);
    expect(home.body.total).toBeGreaterThan(0);
    expect((await get<Page<StorySummary>>('/api/stories?on=03-07')).body.items.map((s) => s.id)).toEqual([today.storyId]);

    const random = (await get<{ id: string | null }>('/api/stories/random?mode=surprise')).body;
    expect(random.id).toBeTruthy();
    const summaries = (await get<StorySummary[]>(`/api/stories/summaries?ids=${ongoing.storyId},${today.storyId}`)).body;
    expect(summaries.map((s) => s.id)).toEqual([ongoing.storyId, today.storyId]);
  });
});
