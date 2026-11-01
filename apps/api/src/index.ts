import { loadConfig } from './config.js';
import { createApp } from './runtime.js';

// Long-running server for local development (`npm run dev`) and single-machine hosting.
// Run migrations first with `npm run migrate`; this process never changes the schema.
const config = loadConfig();
const app = await createApp(config);
await app.listen({ port: config.PORT, host: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
