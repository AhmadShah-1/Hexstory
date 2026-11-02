import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDb, describeDatabase, type Sql } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
/** Arbitrary constant: the session-level advisory lock that serialises migration runs. */
const MIGRATION_LOCK = 4_815_162_342;

export const ENVIRONMENTS = ['development', 'preview', 'production'] as const;

export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

async function readEnvironmentMarker(sql: Pick<Sql, 'unsafe'>): Promise<string | null> {
  const [row] = await sql.unsafe<{ value: string }[]>(
    `SELECT value FROM app_meta WHERE key = 'environment'`,
  ).catch((err: { code?: string }) => {
    if (err.code === '42P01') return []; // app_meta does not exist yet: a database from before 003
    throw err;
  });
  return row?.value ?? null;
}

/**
 * Applies migrations/NNN_name.sql files in order, each in its own transaction, then records which
 * environment the database belongs to (app_meta.environment). Applied files are recorded in
 * schema_migrations; never edit a migration once applied, add a new one.
 *
 * Runs only from the explicit `migrate` command, never while serving requests. A session-level
 * advisory lock makes a second concurrent run fail fast, which is why it needs a direct
 * (unpooled) connection: PgBouncer in transaction mode can't hold session locks.
 */
export async function migrate(
  sql: Sql,
  options: { environment: string; retarget?: boolean; log?: (msg: string) => void },
): Promise<void> {
  const { environment, retarget = false, log = console.log } = options;
  const conn = await sql.reserve();
  try {
    const [lock] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${MIGRATION_LOCK}) AS locked`;
    if (!lock?.locked) throw new Error('Another migration is running against this database. Wait for it to finish, then retry.');
    try {
      const marker = await readEnvironmentMarker(conn);
      if (marker && marker !== environment && !retarget) {
        throw new Error(
          `This database is marked "${marker}" but you are migrating it as "${environment}". ` +
            'Check which DATABASE_URL you are using. Pass --retarget only if you deliberately copied this database (e.g. a Neon branch).',
        );
      }

      await conn`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const applied = new Set((await conn<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
      for (const file of await migrationFiles()) {
        if (applied.has(file)) continue;
        const text = await readFile(MIGRATIONS_DIR + file, 'utf8');
        await conn.unsafe('BEGIN');
        try {
          // Fail instead of queueing behind live traffic for long if a table is busy.
          await conn.unsafe(`SET LOCAL lock_timeout = '15s'`);
          await conn.unsafe(text);
          await conn`INSERT INTO schema_migrations (name) VALUES (${file})`;
          await conn.unsafe('COMMIT');
        } catch (err) {
          await conn.unsafe('ROLLBACK');
          throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
        }
        log(`applied ${file}`);
      }

      if (marker !== environment) {
        await conn`
          INSERT INTO app_meta (key, value) VALUES ('environment', ${environment})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
        log(`marked database as "${environment}"`);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    conn.release();
  }
}

/**
 * Read-only startup (and build-time) guard: the database must belong to this deployment's
 * environment and have every migration this code expects. Never changes the schema.
 */
export async function checkDatabase(sql: Sql, environment: string): Promise<void> {
  const marker = await readEnvironmentMarker(sql);
  if (marker !== environment) {
    throw new Error(
      marker
        ? `Refusing to start: the database is marked "${marker}" but this deployment is "${environment}". Point DATABASE_URL at the ${environment} database.`
        : `Refusing to start: the database has not been prepared for "${environment}". Run the migrate command first (docs/DEPLOYMENT.md).`,
    );
  }
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const pending = (await migrationFiles()).filter((f) => !applied.has(f));
  if (pending.length > 0) {
    throw new Error(`Refusing to start: migrations not yet applied: ${pending.join(', ')}. Run the migrate command first (docs/DEPLOYMENT.md).`);
  }
}

/** The direct connection string; migrations must not go through PgBouncer. */
export function migrationUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL_UNPOOLED (or DATABASE_URL locally); e.g. `npm run migrate:production`, which asks for it.');
  if (/-pooler\./.test(new URL(url).hostname)) {
    throw new Error('That is a pooled (PgBouncer) connection string. Set DATABASE_URL_UNPOOLED to the direct connection string.');
  }
  return url;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: Error) => {
    console.error(`[migrate] ${err.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const { values } = parseArgs({
    options: { env: { type: 'string' }, retarget: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } },
  });
  const environment = values.env ?? process.env.VERCEL_ENV ?? 'development';
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new Error(`--env must be one of ${ENVIRONMENTS.join(', ')}`);
  }
  // The read-only check may use the pooled URL; applying migrations needs the direct one.
  const url = values.check ? process.env.DATABASE_URL : migrationUrl(process.env);
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = createDb(url, { max: 1 });
  try {
    if (values.check) {
      await checkDatabase(sql, environment);
      console.log(`[migrate] ${describeDatabase(url)} is up to date for "${environment}"`);
    } else {
      console.log(`[migrate] ${describeDatabase(url)} as "${environment}"`);
      await migrate(sql, { environment, retarget: values.retarget, log: (m) => console.log(`[migrate] ${m}`) });
      console.log('[migrate] done');
    }
  } finally {
    await sql.end();
  }
}
