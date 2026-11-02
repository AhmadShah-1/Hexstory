import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { checkPlaces } from '../src/import/checks.js';
import { photoKey, readImportFiles, toStoryInput } from '../src/import/format.js';
import { event } from './import-fixtures.js';

async function files(lines: unknown[], opts: { photo?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hexstory-import-'));
  if (opts.photo) {
    await mkdir(join(dir, 'photos'));
    await writeFile(join(dir, 'photos', 'square.png'), await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c2410c' } }).png().toBuffer());
  }
  const file = join(dir, 'events.jsonl');
  await writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return file;
}
const errors = (issues: { level: string; message: string }[]) => issues.filter((i) => i.level === 'error').map((i) => i.message);

describe('import files', () => {
  it('accepts a valid event and turns it into the same input the editor produces', async () => {
    const { records, issues } = await readImportFiles([await files([event({ people: ['Hosni Mubarak'] })])]);
    expect(errors(issues)).toEqual([]);
    const input = toStoryInput(records[0]!.record, new Map(), null);
    expect(input).toMatchObject({
      title: 'Crowds fill Tahrir Square',
      location: { lat: 30.0444, lng: 31.2357, placeName: 'Tahrir Square, Cairo' },
      start: { year: 2011, month: 1, day: 25 },
      end: { year: 2011, month: 2, day: 11 },
      categories: ['protest', 'politics'],
      people: ['Hosni Mubarak'],
      cells: [],
    });
    expect(input.content.filter((b) => b.type === 'paragraph')).toHaveLength(2);
  });

  it('reports precise problems: keys, dates, sources, categories, links, duplicates and broken lines', async () => {
    const file = await files([
      event({ key: 'Bad Key' }),
      event({ key: 'no-url', sources: [{ title: 'A book' }] }),
      event({ key: 'bad-date', start: '25/01/2011' }),
      event({ key: 'future', start: '2999-01-01', end: null }),
      event({ key: 'bad-category', categories: ['gossip'] }),
      event({ key: 'self-link', links: [{ key: 'self-link', relation: 'related' }] }),
      event({ key: 'dupe' }),
      event({ key: 'dupe', title: 'Another title entirely' }),
      '{ not json',
    ]);
    const { issues } = await readImportFiles([file]);
    const all = issues.map((i) => `${i.where} ${i.message}`).join('\n');
    expect(all).toMatch(/\[Bad Key\] key: key must be lowercase/);
    expect(all).toMatch(/\[no-url\] sources\.0.*needs a title and a url|\[no-url\] sources\.0\.url/);
    expect(all).toMatch(/\[bad-date\] start: must look like 2023/);
    expect(all).toMatch(/\[future\] start.*future/i);
    expect(all).toMatch(/\[bad-category\] categories\.0/);
    expect(all).toMatch(/\[self-link\] links: a story cannot link to itself/);
    expect(all).toMatch(/\[dupe\] duplicate key/);
    expect(all).toMatch(/events\.jsonl:9 not valid JSON/);
  });

  it('warns about links to keys it cannot see, and errors once the database is known', async () => {
    const file = await files([event({ links: [{ key: 'elsewhere', relation: 'led-to' }] })]);
    expect((await readImportFiles([file])).issues).toContainEqual(expect.objectContaining({ level: 'warning', message: expect.stringMatching(/"elsewhere"/) }));
    expect(errors((await readImportFiles([file], { knownKeys: new Set() })).issues)).toEqual([expect.stringMatching(/"elsewhere"/)]);
    expect(errors((await readImportFiles([file], { knownKeys: new Set(['elsewhere']) })).issues)).toEqual([]);
  });

  it('requires photos to be freely licensed, attributed, present and inside the photos folder', async () => {
    const photo = { file: 'square.png', author: 'Jane Photographer', license: 'CC BY-SA 4.0', source: 'https://commons.wikimedia.org/wiki/File:Square.png' };
    const ok = await readImportFiles([await files([event({ photo })], { photo: true })]);
    expect(errors(ok.issues)).toEqual([]);
    expect(ok.records[0]!.photoPath).toMatch(/photos\/square\.png$/);

    const bad = await readImportFiles([await files([
      event({ key: 'no-licence', photo: { ...photo, license: 'All rights reserved' } }),
      event({ key: 'escape', photo: { ...photo, file: '../secret.png' } }),
      event({ key: 'missing', photo: { ...photo, file: 'nope.jpg' } }),
    ], { photo: true })]);
    const all = bad.issues.map((i) => `${i.where} ${i.message}`).join('\n');
    expect(all).toMatch(/\[no-licence\] photo\.license: licence must be one of/);
    expect(all).toMatch(/\[escape\] photo\.file must be inside the photos folder/);
    expect(all).toMatch(/\[missing\] photo\.file not found/);
  });

  it('puts the photo first with its credit, and lists its page as a source', async () => {
    const { records } = await readImportFiles([await files([event({ photo: { file: 'square.png', caption: 'The square on 1 February', author: 'J. Doe', license: 'cc by 2.0', source: 'https://commons.wikimedia.org/wiki/File:Square.png' } })], { photo: true })]);
    const input = toStoryInput(records[0]!.record, new Map(), photoKey(Buffer.from('x')));
    expect(input.content[0]).toMatchObject({ type: 'image', caption: 'The square on 1 February (Photo: J. Doe, CC BY 2.0)' });
    expect(input.sources.at(-1)).toMatchObject({ url: 'https://commons.wikimedia.org/wiki/File:Square.png' });
  });

  it('reads JSON arrays as well as JSON Lines', async () => {
    const file = await files([]);
    await writeFile(file, JSON.stringify([event(), event({ key: 'second-event', title: 'Second event here' })]));
    const { records, issues } = await readImportFiles([file]);
    expect(errors(issues)).toEqual([]);
    expect(records).toHaveLength(2);
  });
});

describe('place check', () => {
  // Nominatim-shaped answers: Cairo's area, and nothing for an unknown place.
  const CAIRO = { lat: '30.0444', lon: '31.2357', boundingbox: ['29.88', '30.15', '31.15', '31.40'] };
  const geocoder = (answers: Record<string, unknown[]>) =>
    (async (url: string) => {
      const q = new URL(url).searchParams.get('q')!;
      return q in answers ? Response.json(answers[q]) : new Response('busy', { status: 503 });
    }) as unknown as typeof fetch;
  const run = async (lines: unknown[], fetchImpl: typeof fetch) => {
    const { records } = await readImportFiles([await files(lines)]);
    const cache = { urls: {}, places: {} };
    return { issues: await checkPlaces(records, cache, () => {}, { fetchImpl, gapMs: 0 }), cache };
  };
  const dev = (place: string, lat: number, lng: number) => ({ date: '2011-02-01', title: 'A march', location: { lat, lng, place }, sources: [{ title: 'S', url: 'https://example.org/s' }] });

  it('accepts points inside the place area and warns about points outside it, developments included', async () => {
    const { issues } = await run(
      [event({ location: { lat: 30.0444, lng: 31.2357, place: 'Cairo, Egypt' }, developments: [dev('Cairo, Egypt', 30.3, 31.2357), dev('Atlantis', 0, 0)] })],
      geocoder({ 'Cairo, Egypt': [CAIRO], Atlantis: [] }),
    );
    expect(issues.map((i) => i.where.replace(/^.*\] /, ''))).toEqual(['developments.0', 'developments.1']);
    expect(issues[0]!.message).toMatch(/^coordinates are 28 km from "Cairo, Egypt" .* outside the area/);
    expect(issues[1]!.message).toMatch(/^place "Atlantis" not found by the geocoder/);
  });

  it('says so when the geocoder could not be reached, instead of passing, and does not cache the failure', async () => {
    const { issues, cache } = await run([event({ location: { lat: 30.0444, lng: 31.2357, place: 'Cairo, Egypt' } })], geocoder({}));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', where: 'place check' });
    expect(issues[0]!.message).toContain('1 of 1 places could not be looked up (geocoder answered 503)');
    expect(cache.places).toEqual({});
  });
});
