import { buildApp } from './app.js';
import { isGoogleConfigured, type Config } from './config.js';
import { connectRedis, createMemoryCoordinator, createRedisCoordinator } from './coordination.js';
import { createDb, describeDatabase } from './db.js';
import { checkDatabase } from './migrate.js';
import { createLocalStorage, type Storage } from './storage/index.js';
import { createR2Storage } from './storage/r2.js';

/**
 * Wires the app to its real services; shared by the long-running server (index.ts) and the Vercel
 * Function (serverless.ts). Runs once per process. It never migrates: it refuses to start against
 * a database that belongs to another environment or lacks migrations (see migrate.ts).
 */
export async function createApp(config: Config) {
  const log = (msg: string, err?: unknown) => console.error(`[startup] ${msg}`, err ?? '');
  const sql = createDb(config.DATABASE_URL, { max: config.DB_POOL_MAX, serverless: config.VERCEL === '1' });
  try {
    await checkDatabase(sql, config.DEPLOY_ENV);
  } catch (err) {
    await sql.end({ timeout: 1 });
    throw new Error(`${(err as Error).message} [database: ${describeDatabase(config.DATABASE_URL)}]`);
  }

  const coordinator = config.REDIS_URL
    ? createRedisCoordinator(await connectRedis(config.REDIS_URL, log), `hx:${config.DEPLOY_ENV}:`)
    : createMemoryCoordinator();

  const app = await buildApp({ config, sql, storage: createStorage(config), coordinator });
  app.addHook('onClose', async () => {
    await coordinator.close();
    await sql.end({ timeout: 5 });
  });
  if (!isGoogleConfigured(config)) {
    app.log.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: sign-in is disabled, the site is read-only.');
  }
  if (!config.REDIS_URL) app.log.info('REDIS_URL not set: rate limits and caches are kept in this process only.');
  return app;
}

function createStorage(config: Config): Storage {
  if (config.STORAGE_BACKEND === 'local') return createLocalStorage(config.UPLOAD_DIR);
  return createR2Storage({
    endpoint: config.R2_ENDPOINT!,
    bucket: config.R2_BUCKET!,
    stagingBucket: config.R2_STAGING_BUCKET!,
    accessKeyId: config.R2_ACCESS_KEY_ID!,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    publicBaseUrl: config.R2_PUBLIC_BASE_URL!,
  });
}
