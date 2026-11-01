import { AwsClient } from 'aws4fetch';
import type { Storage } from './index.js';

export interface R2Config {
  /** S3 API endpoint, https://<account id>.r2.cloudflarestorage.com */
  endpoint: string;
  /** Public bucket for processed images, served from `publicBaseUrl` (an R2 custom domain). */
  bucket: string;
  /** Private bucket for unvalidated originals; a lifecycle rule deletes leftovers after a day. */
  stagingBucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

/** How long a browser has to start its upload after asking for one. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Cloudflare R2 through its S3-compatible API, signed with aws4fetch (small, fetch-based).
 * Server credentials never leave the API: the browser only ever gets one pre-signed PUT URL for a
 * single staging key, with the exact byte count and content type signed in.
 */
export function createR2Storage(config: R2Config, fetchImpl: typeof fetch = fetch): Storage {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const publicBase = config.publicBaseUrl.replace(/\/+$/, '');
  const objectUrl = (bucket: string, name: string) =>
    `${endpoint}/${bucket}/${name.split('/').map(encodeURIComponent).join('/')}`;

  const send = async (method: string, url: string, init: { body?: Buffer; headers?: Record<string, string> } = {}) =>
    fetchImpl(await aws.sign(url, { method, headers: init.headers, body: init.body && new Uint8Array(init.body) }));

  const expect = async (res: Response, what: string, ok: (status: number) => boolean) => {
    if (!ok(res.status)) {
      await res.body?.cancel();
      throw new Error(`R2 ${what} failed with HTTP ${res.status}`);
    }
  };

  return {
    localDir: null,
    imageOrigin: new URL(publicBase).origin,
    uploadOrigin: new URL(endpoint).origin,

    async put(name, data, contentType) {
      const res = await send('PUT', objectUrl(config.bucket, name), {
        body: data,
        headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' },
      });
      await expect(res, `upload of ${name}`, (s) => s === 200);
    },
    async exists(name) {
      const res = await send('HEAD', objectUrl(config.bucket, name));
      if (res.status === 404) return false;
      await expect(res, `lookup of ${name}`, (s) => s === 200);
      return true;
    },
    async delete(name) {
      const res = await send('DELETE', objectUrl(config.bucket, name));
      await expect(res, `delete of ${name}`, (s) => s === 204 || s === 200 || s === 404);
    },
    publicUrl: (name) => `${publicBase}/${name}`,

    async stagingTarget(key, size) {
      const url = new URL(objectUrl(config.stagingBucket, key));
      url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL_SECONDS));
      const headers = { 'content-type': 'application/octet-stream' };
      // allHeaders signs content-length too, so R2 rejects a body of any other size.
      const signed = await aws.sign(url.toString(), {
        method: 'PUT',
        headers: { ...headers, 'content-length': String(size) },
        aws: { signQuery: true, allHeaders: true },
      });
      return { url: signed.url, method: 'PUT', headers };
    },
    async readStaged(key, maxBytes) {
      const res = await send('GET', objectUrl(config.stagingBucket, key));
      if (res.status === 404) {
        await res.body?.cancel();
        return 'missing';
      }
      await expect(res, 'read of staged upload', (s) => s === 200);
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (!(declared <= maxBytes)) {
        await res.body?.cancel();
        return 'too-large';
      }
      const data = Buffer.from(await res.arrayBuffer());
      return data.length > maxBytes ? 'too-large' : data;
    },
    async deleteStaged(key) {
      const res = await send('DELETE', objectUrl(config.stagingBucket, key));
      await expect(res, 'delete of staged upload', (s) => s === 204 || s === 200 || s === 404);
    },
  };
}
