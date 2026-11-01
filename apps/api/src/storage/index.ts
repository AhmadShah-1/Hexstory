import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** Where the browser sends an image original: a pre-signed URL, or the API itself locally. */
export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/**
 * Where images live. Published images (processed WebP files) are public; originals are uploaded
 * by the browser to private *staging* storage first, then validated and re-encoded by the API.
 * Staged keys look like `<userId>/<uploadId>`, so one user can never reach another's upload.
 */
export interface Storage {
  put(name: string, data: Buffer, contentType: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  delete(name: string): Promise<void>;
  publicUrl(name: string): string;
  /** Local directory to serve at /media, or null when files are served elsewhere. */
  localDir: string | null;
  /** Origins the page must be allowed to load images from and upload to (CSP), if not our own. */
  imageOrigin: string | null;
  uploadOrigin: string | null;
  /** Where the browser should PUT exactly `size` bytes for a staged upload. */
  stagingTarget(key: string, size: number): Promise<UploadTarget>;
  /** A staged original, or why it can't be used. Never reads more than `maxBytes`. */
  readStaged(key: string, maxBytes: number): Promise<Buffer | 'missing' | 'too-large'>;
  deleteStaged(key: string): Promise<void>;
  /** Local backend only: the API receives originals itself (there is no bucket to sign for). */
  writeStaged?(key: string, data: Buffer): Promise<void>;
}

export const imageFileNames = (key: string) => ({ full: `${key}.webp`, thumb: `${key}-thumb.webp` });
export const stagedKey = (userId: string, uploadId: string) => `${userId}/${uploadId}`;

/**
 * Local disk, for development. Staged originals go to a sibling directory that is never served.
 */
export function createLocalStorage(dir: string): Storage {
  const root = resolve(dir);
  const staging = join(dirname(root), `${basename(root)}-staging`);
  mkdirSync(root, { recursive: true });
  const missing = (err: { code?: string }) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  };

  return {
    localDir: root,
    imageOrigin: null,
    uploadOrigin: null,
    async put(name, data) {
      await writeFile(join(root, name), data);
    },
    async exists(name) {
      return stat(join(root, name)).then(
        () => true,
        () => false,
      );
    },
    async delete(name) {
      await rm(join(root, name), { force: true });
    },
    publicUrl: (name) => `/media/${name}`,
    async stagingTarget(key) {
      const uploadId = key.split('/')[1];
      return { url: `/api/uploads/${uploadId}/original`, method: 'PUT', headers: { 'content-type': 'application/octet-stream' } };
    },
    async writeStaged(key, data) {
      await mkdir(dirname(join(staging, key)), { recursive: true });
      await writeFile(join(staging, key), data);
    },
    async readStaged(key, maxBytes) {
      const info = await stat(join(staging, key)).catch(missing);
      if (!info) return 'missing';
      if (info.size > maxBytes) return 'too-large';
      return readFile(join(staging, key));
    },
    async deleteStaged(key) {
      await rm(join(staging, key), { force: true });
    },
  };
}
