import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPageRequest } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrationUrl } from '../src/migrate.js';
import { createR2Storage } from '../src/storage/r2.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost/db', APP_ORIGIN: 'https://hexstory.example' };
const r2 = {
  R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
  R2_BUCKET: 'hexstory-images',
  R2_STAGING_BUCKET: 'hexstory-staging',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_PUBLIC_BASE_URL: 'https://images.hexstory.example',
};

describe('configuration', () => {
  it('keeps local development free of cloud services', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ STORAGE_BACKEND: 'local', DEPLOY_ENV: 'development', DB_POOL_MAX: 10, TRUST_PROXY: false });
    expect(config.REDIS_URL).toBeUndefined();
  });

  it('on Vercel requires R2 (Redis is optional), and uses small pools and the proxy client IP', () => {
    expect(() => loadConfig({ ...base, VERCEL: '1', VERCEL_ENV: 'production' })).toThrow(/R2_ENDPOINT/);
    const config = loadConfig({ ...base, ...r2, VERCEL: '1', VERCEL_ENV: 'preview', REDIS_URL: 'rediss://default:pw@redis.example:6379' });
    expect(config).toMatchObject({ NODE_ENV: 'production', STORAGE_BACKEND: 'r2', DEPLOY_ENV: 'preview', DB_POOL_MAX: 5, TRUST_PROXY: true });
    expect(loadConfig({ ...base, ...r2, VERCEL: '1', VERCEL_ENV: 'production' }).REDIS_URL).toBeUndefined();
  });

  it('refuses local disk storage on Vercel', () => {
    const env = { ...base, VERCEL: '1', VERCEL_ENV: 'production', REDIS_URL: 'redis://r:6379', STORAGE_BACKEND: 'local' };
    expect(() => loadConfig(env)).toThrow(/STORAGE_BACKEND/);
  });

  it('runs migrations only over a direct connection', () => {
    expect(() => migrationUrl({ DATABASE_URL: 'postgres://u:p@ep-cool-1-pooler.us-east-1.aws.neon.tech/db' })).toThrow(/pooled/);
    const direct = 'postgres://u:p@ep-cool-1.us-east-1.aws.neon.tech/db';
    expect(migrationUrl({ DATABASE_URL: 'postgres://u:p@ep-cool-1-pooler.us-east-1.aws.neon.tech/db', DATABASE_URL_UNPOOLED: direct })).toBe(direct);
  });
});

describe('routing', () => {
  it('serves the app for page navigations only', () => {
    for (const page of ['/', '/h/831fb4fffffffff', '/s/5d1c1d1e-6f2b-4a39-9a9e-0e1f2a3b4c5d/versions', '/about?x=1']) {
      expect(isPageRequest('GET', page), page).toBe(true);
    }
    for (const [method, url] of [
      ['GET', '/api/nope'],
      ['GET', '/auth/google/callback'],
      ['GET', '/socket.io/?EIO=4'],
      ['GET', '/assets/index-abc.js'],
      ['GET', '/favicon.ico'],
      ['GET', '/media/x.webp'],
      ['POST', '/about'],
    ]) {
      expect(isPageRequest(method!, url!), `${method} ${url}`).toBe(false);
    }
  });

  it('sends everything except built assets to the Function on Vercel', () => {
    const vercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'));
    const [rewrite] = vercel.rewrites;
    expect(rewrite.destination).toBe('/api');
    const source = new RegExp(`^${rewrite.source}$`);
    for (const path of ['/', '/api/session', '/auth/google/callback', '/socket.io/', '/h/831fb4fffffffff']) {
      expect(source.test(path), path).toBe(true);
    }
    expect(source.test('/assets/index-abc.js')).toBe(false); // a missing asset is a CDN 404, never the SPA
    expect(vercel.functions['api/index.js'].includeFiles).toContain('apps/api/migrations/*.sql');
  });
});

describe('R2 storage', () => {
  const calls: { method: string; url: string }[] = [];
  const respond = (status: number, body?: string) => async (req: RequestInfo | URL) => {
    const r = req as Request;
    calls.push({ method: r.method, url: r.url });
    return new Response(body ?? null, { status, headers: body ? { 'content-length': String(body.length) } : {} });
  };

  it('signs one PUT of an exact size into the private staging bucket', async () => {
    const storage = createR2Storage(
      { endpoint: r2.R2_ENDPOINT, bucket: r2.R2_BUCKET, stagingBucket: r2.R2_STAGING_BUCKET, accessKeyId: 'key', secretAccessKey: 'secret', publicBaseUrl: r2.R2_PUBLIC_BASE_URL },
      respond(200),
    );
    const target = await storage.stagingTarget('user-1/upload-1', 12_345);
    const url = new URL(target.url);
    expect(url.origin + url.pathname).toBe('https://acc.r2.cloudflarestorage.com/hexstory-staging/user-1/upload-1');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
    expect(target.headers).toEqual({ 'content-type': 'application/octet-stream' });
    expect(target.url).not.toContain('secret');
    expect(storage.publicUrl('k.webp')).toBe('https://images.hexstory.example/k.webp');
    expect([storage.imageOrigin, storage.uploadOrigin]).toEqual(['https://images.hexstory.example', 'https://acc.r2.cloudflarestorage.com']);
  });

  it('reports failed writes and oversized or missing originals', async () => {
    const make = (fetchImpl: typeof fetch) =>
      createR2Storage(
        { endpoint: r2.R2_ENDPOINT, bucket: 'b', stagingBucket: 's', accessKeyId: 'k', secretAccessKey: 's', publicBaseUrl: r2.R2_PUBLIC_BASE_URL },
        fetchImpl,
      );
    await expect(make(respond(500)).put('k.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(/HTTP 500/);
    expect(await make(respond(404)).readStaged('u/1', 10)).toBe('missing');
    expect(await make(respond(200, 'x'.repeat(11))).readStaged('u/1', 10)).toBe('too-large');
    expect((await make(respond(200, 'abc')).readStaged('u/1', 10)) as Buffer).toEqual(Buffer.from('abc'));
    expect(await make(respond(404)).exists('k.webp')).toBe(false);
    await expect(make(respond(403)).exists('k.webp')).rejects.toThrow(/HTTP 403/);
  });
});
