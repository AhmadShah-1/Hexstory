import { loadConfig } from './config.js';
import { createApp } from './runtime.js';

/**
 * Vercel Function entry (bundled to dist/vercel.mjs and re-exported by /api/index.js).
 *
 * Module scope runs once per function instance, so one app, one database pool, one pair of Redis
 * connections and one presence timer serve every request and WebSocket the instance receives
 * (Fluid compute runs many concurrently). Vercel hands requests and WebSocket upgrades to the
 * exported Node server, which is Fastify's, with Socket.IO attached.
 */
const app = await createApp(loadConfig());
await app.ready();

export default app.server;
