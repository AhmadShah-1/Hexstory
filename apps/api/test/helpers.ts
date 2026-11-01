import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellAt, legacyDoc, type CreateStoryInput, type TrustLevel } from '@hexstory/shared';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE, createSession } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createLocalStorage } from '../src/storage/index.js';

export const ORIGIN = 'http://localhost:5173';

/** Builds an app against TEST_DATABASE_URL with a freshly migrated, empty schema. */
export async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to an empty database to run API tests');
  const sql = createDb(url);
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, () => {});

  const uploadDir = await mkdtemp(join(tmpdir(), 'hexstory-test-'));
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, APP_ORIGIN: ORIGIN, UPLOAD_DIR: uploadDir });
  const storage = createLocalStorage(uploadDir);
  const app = await buildApp({ config, sql, storage });
  return { app, sql, uploadDir };
}

let userCounter = 0;

/** Creates a user directly in the database and returns request headers carrying their session. */
export async function makeUser(
  sql: Sql,
  opts: { trust?: TrustLevel; termsAccepted?: boolean; ageDays?: number } = {},
) {
  userCounter++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (google_sub, email, display_name, trust_level, terms_accepted_at, created_at)
    VALUES (${`sub-${userCounter}`}, ${`u${userCounter}@example.com`}, ${`User ${userCounter}`}, ${opts.trust ?? 0},
            ${opts.termsAccepted === false ? null : new Date()},
            ${new Date(Date.now() - (opts.ageDays ?? 0) * 86_400_000)})
    RETURNING id`;
  const { token } = await createSession(sql, user!.id);
  return { id: user!.id, headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN } };
}

export const PARIS = cellAt(48.8566, 2.3522, 5);

/** A valid story; `body` is a plain-text shortcut for a content made of paragraphs. */
export function storyInput({ body, ...overrides }: Partial<CreateStoryInput> & { body?: string } = {}): CreateStoryInput {
  return {
    title: 'The storming of the Bastille',
    content: legacyDoc(
      body ?? 'On 14 July 1789 a crowd stormed the Bastille fortress in Paris, a flashpoint of the French Revolution.',
      null,
      null,
    ),
    cells: [PARIS],
    start: { year: 1789, month: 7, day: 14 },
    end: null,
    isOngoing: false,
    isApprox: false,
    sources: [{ title: 'The French Revolution: A History', url: 'https://example.org/revolution' }],
    ...overrides,
  };
}
