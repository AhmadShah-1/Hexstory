import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDb, type Sql } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * Applies migrations/NNN_name.sql files in order, each in its own transaction.
 * Applied files are recorded in schema_migrations; never edit a migration once applied, add a new one.
 */
export async function migrate(sql: Sql, log: (msg: string) => void = console.log): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(MIGRATIONS_DIR + file, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    log(`applied ${file}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (run through `doppler run`)');
  const sql = createDb(url);
  await migrate(sql);
  await sql.end();
}
