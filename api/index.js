// The Vercel Function serving everything that isn't a static file: the API, Google sign-in,
// Socket.IO (WebSockets) and page navigations. Built by scripts/vercel-build.mjs from
// apps/api/src/serverless.ts; see docs/DEPLOYMENT.md.
export { default } from '../apps/api/dist/vercel.mjs';
