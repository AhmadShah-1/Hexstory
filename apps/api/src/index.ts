import { buildApp } from './app.js';
import { isGoogleConfigured, loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { createLocalStorage } from './storage/index.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
await migrate(sql, (msg) => console.log(`[migrate] ${msg}`));

const app = await buildApp({ config, sql, storage: createLocalStorage(config.UPLOAD_DIR) });
if (!isGoogleConfigured(config)) {
  app.log.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: sign-in is disabled, the site is read-only.');
}
await app.listen({ port: config.PORT, host: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
