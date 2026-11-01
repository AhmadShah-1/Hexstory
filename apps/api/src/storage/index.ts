import { mkdirSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Where uploaded images live. Only a local-disk implementation exists today; an S3/R2
 * implementation only needs to satisfy this interface (and `publicUrl` would return a CDN URL).
 */
export interface Storage {
  put(name: string, data: Buffer, contentType: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  publicUrl(name: string): string;
  /** Local directory to serve at /media, or null when files are served elsewhere. */
  localDir: string | null;
}

export function createLocalStorage(dir: string): Storage {
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  return {
    localDir: root,
    async put(name, data) {
      await writeFile(join(root, name), data);
    },
    async exists(name) {
      return stat(join(root, name)).then(
        () => true,
        () => false,
      );
    },
    publicUrl: (name) => `/media/${name}`,
  };
}

export const imageFileNames = (key: string) => ({ full: `${key}.webp`, thumb: `${key}-thumb.webp` });
