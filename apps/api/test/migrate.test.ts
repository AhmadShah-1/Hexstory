import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Sql } from '../src/db.js';
import { checkDatabase, migrate } from '../src/migrate.js';
import { createApp } from '../src/runtime.js';
import { resetDatabase, testConfig, testDatabaseUrl } from './helpers.js';

let sql: Sql;
beforeAll(async () => {
  sql = createDb(testDatabaseUrl());
  await resetDatabase(sql); // migrated and marked "development"
});
afterAll(() => sql.end());

describe('migrations and environment separation', () => {
  it('refuses to migrate a database that belongs to another environment', async () => {
    await expect(migrate(sql, { environment: 'production', log: () => {} })).rejects.toThrow(/marked "development"/);
  });

  it('refuses to start against another environment, and never migrates while starting', async () => {
    await expect(checkDatabase(sql, 'production')).rejects.toThrow(/marked "development"/);

    await sql`DELETE FROM schema_migrations WHERE name = '003_app_meta.sql'`;
    await expect(createApp(testConfig())).rejects.toThrow(/not yet applied: 003_app_meta.sql/);
    const [row] = await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '003_app_meta.sql'`;
    expect(row!.n).toBe(0); // startup only checked; it did not apply anything
    await sql`INSERT INTO schema_migrations (name) VALUES ('003_app_meta.sql')`;

    const app = await createApp(testConfig());
    await app.close();
  });

  it('lets only one migration run at a time', async () => {
    const other = createDb(testDatabaseUrl(), { max: 1 });
    const holder = await other.reserve();
    await holder`SELECT pg_advisory_lock(4815162342)`;
    try {
      await expect(migrate(sql, { environment: 'development', log: () => {} })).rejects.toThrow(/Another migration is running/);
    } finally {
      await holder`SELECT pg_advisory_unlock(4815162342)`;
      holder.release();
      await other.end();
    }
    await expect(migrate(sql, { environment: 'development', log: () => {} })).resolves.toBeUndefined();
  });
});
