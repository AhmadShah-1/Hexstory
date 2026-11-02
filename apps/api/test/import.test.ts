import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Development, MapPoint, StoryDetail } from '@hexstory/shared';
import { readImportFiles } from '../src/import/format.js';
import { applyImport, planImport, removeBatch } from '../src/import/run.js';
import { createLocalStorage } from '../src/storage/index.js';
import { makeUser, setup } from './helpers.js';
import { event } from './import-fixtures.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});

const get = <T>(url: string, headers: Record<string, string> = {}) => ctx.app.inject({ url, headers }).then((r) => r.json<T>());
const idOf = async (key: string) => (await ctx.sql<{ id: string }[]>`SELECT id FROM stories WHERE import_key = ${key}`)[0]!.id;

async function write(dir: string, lines: unknown[]) {
  const file = join(dir, 'events.jsonl');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

describe('bulk import', () => {
  it('imports, re-runs without duplicates, updates, connects, adds timelines and photos, and removes a batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hexstory-import-'));
    await mkdir(join(dir, 'photos'));
    await writeFile(join(dir, 'photos', 'cairo.png'), await sharp({ create: { width: 64, height: 48, channels: 3, background: '#1d4ed8' } }).png().toBuffer());
    const storage = createLocalStorage(ctx.uploadDir);
    const sudan = event({
      key: 'sudan-war-2023', title: 'War in Sudan', summary: 'A war between the army and the Rapid Support Forces that began in Khartoum.',
      start: '2023-04-15', end: null, ongoing: true, categories: ['war'],
      location: { lat: 15.5007, lng: 32.5599, place: 'Khartoum' },
      links: [{ key: 'tahrir-square-2011', relation: 'related' }],
      developments: [{ date: '2023-12-18', title: 'RSF enter Wad Madani', location: { lat: 14.4, lng: 33.52, place: 'Wad Madani' }, sources: [{ title: 'Report', url: 'https://example.org/wad-madani' }] }],
    });
    const tahrir = event({ photo: { file: 'cairo.png', author: 'J. Doe', license: 'CC BY-SA 4.0', source: 'https://commons.wikimedia.org/wiki/File:Cairo.png' } });
    let file = await write(dir, [sudan, tahrir]);
    const read = async () => {
      const { records, issues } = await readImportFiles([file]);
      expect(issues.filter((i) => i.level === 'error')).toEqual([]);
      return records;
    };

    expect(await planImport({ sql: ctx.sql, storage }, await read())).toMatchObject({ create: 2, update: 0, developments: 1 });
    const first = await applyImport({ sql: ctx.sql, storage }, await read(), { batch: 'test-batch' });
    expect(first).toMatchObject({ created: 2, updated: 0, developmentsAdded: 1, photosStored: 1, failed: [] });

    // Connections were filled in although the target was created in the same run, and show both ways.
    const sudanStory = await get<StoryDetail>(`/api/stories/${await idOf('sudan-war-2023')}`);
    expect(sudanStory).toMatchObject({ imported: true, status: 'active', createdBy: { displayName: 'Hexstory Archive' } });
    expect(sudanStory.connections).toMatchObject([{ relation: 'related', direction: 'out', story: { title: 'Crowds fill Tahrir Square' } }]);
    expect(sudanStory.developments.map((d: Development) => d.title)).toEqual(['RSF enter Wad Madani']);
    const tahrirStory = await get<StoryDetail>(`/api/stories/${await idOf('tahrir-square-2011')}`);
    expect(tahrirStory.connections).toMatchObject([{ relation: 'related', direction: 'in' }]);
    expect(tahrirStory.revision.content[0]).toMatchObject({ type: 'image', caption: 'Photo: J. Doe, CC BY-SA 4.0' });
    expect(tahrirStory.revision.thumbUrl).toBeTruthy();
    expect((await get<MapPoint[]>('/api/map/points')).map((p) => p.title)).toEqual(expect.arrayContaining(['War in Sudan', 'Crowds fill Tahrir Square']));

    // Running it again changes nothing.
    expect(await applyImport({ sql: ctx.sql, storage }, await read(), { batch: 'test-batch' }))
      .toMatchObject({ created: 0, updated: 0, unchanged: 2, developmentsAdded: 0, photosStored: 0 });

    // A changed row becomes a new version; a new development is added once.
    file = await write(dir, [
      { ...sudan, summary: 'A war between Sudan’s army and the Rapid Support Forces that began in Khartoum in April 2023.',
        developments: [...((sudan as { developments?: object[] }).developments ?? []), { date: '2025-03-21', title: 'The army retakes the Republican Palace', sources: [{ title: 'Report', url: 'https://example.org/palace' }] }] },
      tahrir,
    ]);
    expect(await applyImport({ sql: ctx.sql, storage }, await read(), { batch: 'test-batch' })).toMatchObject({ updated: 1, unchanged: 1, developmentsAdded: 1 });

    // A story someone edited on the site is left alone.
    const member = await makeUser(ctx.sql, { trust: 1 });
    const tahrirId = await idOf('tahrir-square-2011');
    const base = (await get<StoryDetail>(`/api/stories/${tahrirId}`)).revision;
    const edited = await ctx.app.inject({ method: 'PUT', url: `/api/stories/${tahrirId}`, headers: member.headers, payload: {
      title: base.title, summary: 'Edited on the site by a member, with more detail.', content: base.content, categories: base.categories,
      location: base.location, cells: [], start: base.start, end: base.end, isOngoing: base.isOngoing, isApprox: base.isApprox,
      sources: base.sources, people: base.people, links: base.links, baseRevisionId: base.id } });
    expect(edited.statusCode).toBe(200);
    file = await write(dir, [sudan, { ...tahrir, summary: 'A different summary coming from the import file.' }]);
    expect((await applyImport({ sql: ctx.sql, storage }, await read(), { batch: 'test-batch' })).skippedEdited).toEqual(['tahrir-square-2011']);

    expect(await removeBatch(ctx.sql, 'test-batch', 'test')).toBe(2);
    expect((await ctx.app.inject({ url: `/api/stories/${tahrirId}` })).statusCode).toBe(404);
  });
});
