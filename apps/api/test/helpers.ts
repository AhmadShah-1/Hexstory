import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellAt, legacyDoc, type CreateStoryInput, type TrustLevel, type UploadTicket } from '@hexstory/shared';
import { buildApp } from '../src/app.js';
import { SESSION_COOKIE, createSession } from '../src/auth/sessions.js';
import { loadConfig } from '../src/config.js';
import { createDb, type Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createMemoryCoordinator, type Coordinator } from '../src/coordination.js';
import { createLocalStorage, type Storage } from '../src/storage/index.js';
import type { FastifyInstance } from 'fastify';

export const ORIGIN = 'http://localhost:5173';

/** Builds an app against TEST_DATABASE_URL with a freshly migrated, empty schema. */
export async function setup() {
  const sql = createDb(testDatabaseUrl());
  await resetDatabase(sql);
  const uploadDir = await mkdtemp(join(tmpdir(), 'hexstory-test-'));
  const app = await buildTestApp(sql, { storage: createLocalStorage(uploadDir) });
  return { app, sql, uploadDir };
}

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to an empty database to run API tests');
  return url;
}

export async function resetDatabase(sql: Sql) {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, { environment: 'development', log: () => {} });
}

export const testConfig = () =>
  loadConfig({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), APP_ORIGIN: ORIGIN, UPLOAD_DIR: join(tmpdir(), 'hexstory-test-uploads') });

/** Another app instance over the same database, e.g. with failing storage or a shared coordinator. */
export async function buildTestApp(
  sql: Sql,
  overrides: { storage?: Storage; coordinator?: Coordinator; heartbeatMs?: number } = {},
) {
  return buildApp({
    config: testConfig(),
    sql,
    storage: overrides.storage ?? createLocalStorage(await mkdtemp(join(tmpdir(), 'hexstory-test-'))),
    coordinator: overrides.coordinator ?? createMemoryCoordinator(),
    heartbeatMs: overrides.heartbeatMs,
  });
}

/** Runs the three-step upload against the local storage backend. */
export async function uploadBytes(app: FastifyInstance, headers: Record<string, string>, bytes: Buffer) {
  const ticket = (await app.inject({ method: 'POST', url: '/api/uploads', headers, payload: { size: bytes.length } })).json<UploadTicket>();
  const put = await app.inject({ method: 'PUT', url: ticket.upload.url, headers: { ...headers, ...ticket.upload.headers }, payload: bytes });
  const done = await app.inject({ method: 'POST', url: `/api/uploads/${ticket.id}/complete`, headers, payload: {} });
  return { ticket, put, done };
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
