import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMemoryCoordinator } from '../src/coordination.js';
import { createDb } from '../src/db.js';
import { createR2Storage } from '../src/storage/r2.js';
import { createLocalStorage } from '../src/storage/index.js';

describe('Vercel application startup', () => {
  it('loads the externalized app without require(ESM) support, as the deployed runtime does', async () => {
    // Put the fixture inside the workspace so external npm dependencies resolve normally.
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const dir = await mkdtemp(join(root, '.vercel-import-test-'));
    try {
      const outfile = join(dir, 'app.mjs');
      await build({
        entryPoints: [fileURLToPath(new URL('../src/app.ts', import.meta.url))],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        plugins: [{
          name: 'externalize-npm-packages',
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, (args) =>
              args.path.startsWith('@hexstory/') ? undefined : { path: args.path, external: true },
            );
          },
        }],
      });
      await promisify(execFile)(process.execPath, [
        '--no-experimental-require-module', '--input-type=module',
        '--eval', `await import(${JSON.stringify(pathToFileURL(outfile).href)});`,
      ], { timeout: 10_000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([true, false])('serves secure page HTML and real 404s (Vercel: %s)', async (onVercel) => {
    const dir = await mkdtemp(join(tmpdir(), 'hexstory-html-'));
    const html = '<!doctype html><html><body>Hexstory test page</body></html>';
    await writeFile(join(dir, 'index.html'), html);
    await writeFile(join(dir, 'image.webp'), 'local image fixture');
    const config = loadConfig({
      NODE_ENV: 'production', VERCEL: onVercel ? '1' : undefined, VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      APP_ORIGIN: 'https://www.hexstory.wiki',
      REDIS_URL: 'redis://127.0.0.1:1',
      R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
      R2_BUCKET: 'images', R2_STAGING_BUCKET: 'staging',
      R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test',
      R2_PUBLIC_BASE_URL: 'https://images.hexstory.wiki',
    });
    const sql = createDb(config.DATABASE_URL);
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      app = await buildApp({
        config, sql, webRoot: dir, coordinator: createMemoryCoordinator(),
        storage: onVercel ? createR2Storage({
          endpoint: config.R2_ENDPOINT!, bucket: config.R2_BUCKET!, stagingBucket: config.R2_STAGING_BUCKET!,
          accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
          publicBaseUrl: config.R2_PUBLIC_BASE_URL!,
        }) : createLocalStorage(dir),
      });
      app.log.level = 'silent';
      for (const url of ['/', '/about', '/h/831fb4fffffffff']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['content-security-policy']).toContain("script-src 'self'");
        if (onVercel) expect(response.headers['content-security-policy']).toContain('https://images.hexstory.wiki');
        expect(response.body).toBe(html);
      }
      const head = await app.inject({ method: 'HEAD', url: '/about' });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      for (const url of ['/favicon.ico', '/assets/missing.js', '/media/missing.webp', '/api/missing']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      if (!onVercel) {
        const image = await app.inject({ method: 'GET', url: '/media/image.webp' });
        expect(image.statusCode).toBe(200);
        expect(image.body).toBe('local image fixture');
        expect(image.headers['cache-control']).toContain('immutable');
      }
    } finally {
      await app?.close();
      await sql.end({ timeout: 1 });
      await rm(dir, { recursive: true, force: true });
    }
  });
});
