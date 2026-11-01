// Vercel build (vercel.json "buildCommand"). Produces:
//   apps/web/dist/          the Vite build (index.html is read by the Function, not served as a file)
//   apps/web/dist-static/   the same minus index.html: Vercel's CDN output directory
//   apps/api/dist/vercel.mjs  the API bundled into one ES module, imported by /api/index.js
// Every page navigation therefore reaches the Function, which serves index.html with the
// environment-specific security headers (CSP image/upload origins).
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const run = (cmd, args) => {
  const { status } = spawnSync(cmd, args, { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
};

run('npm', ['run', 'build', '-w', '@hexstory/web']);

rmSync('apps/web/dist-static', { recursive: true, force: true });
cpSync('apps/web/dist', 'apps/web/dist-static', { recursive: true, filter: (src) => !src.endsWith('/dist/index.html') });

await build({
  entryPoints: ['apps/api/src/serverless.ts'],
  outfile: 'apps/api/dist/vercel.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  // Our workspace packages are TypeScript and get bundled; npm packages stay external so Vercel
  // traces them (including sharp's native binaries) into the Function as normal node_modules.
  plugins: [
    {
      name: 'externalize-npm-packages',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@hexstory/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});

// Production and preview builds stop here if the target database is missing migrations or
// belongs to another environment, so a deployment that can't start is never promoted. Read-only.
const env = process.env.VERCEL_ENV;
if ((env === 'production' || env === 'preview') && process.env.SKIP_DB_CHECK !== '1') {
  if (!process.env.DATABASE_URL) {
    console.error(`DATABASE_URL is not set for the ${env} environment.`);
    process.exit(1);
  }
  run('npx', ['tsx', 'apps/api/src/migrate.ts', '--check', '--env', env]);
}
