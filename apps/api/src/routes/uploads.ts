import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import sharp from 'sharp';
import { LIMITS } from '@hexstory/shared';
import { badRequest } from '../errors.js';
import { requireWriter } from '../http.js';
import { POLICY } from '../policy.js';
import { imageFileNames } from '../storage/index.js';
import type { Deps } from './deps.js';

/**
 * Images are always re-encoded: this strips EXIF (including GPS location, which matters for photos
 * of protests), normalises orientation, and guarantees we only ever serve real WebP images.
 */
export const uploadRoutes =
  ({ storage }: Deps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/api/uploads',
      {
        config: {
          rateLimit: {
            max: POLICY.uploadsPerHour,
            timeWindow: '1 hour',
            keyGenerator: (req) => req.user?.id ?? req.ip,
          },
        },
      },
      async (req, reply) => {
        requireWriter(req);
        const file = await req.file({ limits: { fileSize: LIMITS.imageBytesMax, files: 1 } });
        if (!file) throw badRequest('No file was uploaded.');
        const input = await file.toBuffer().catch(() => {
          throw badRequest('Images must be smaller than 6 MB.', 'too-large');
        });

        let full: Buffer, thumb: Buffer;
        try {
          const image = sharp(input, { limitInputPixels: 50_000_000 }).rotate();
          full = await image.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
          thumb = await image.clone().resize(160, 160, { fit: 'cover', position: 'attention' }).webp({ quality: 75 }).toBuffer();
        } catch {
          throw badRequest('That file is not an image we can read. Try a JPEG, PNG or WebP.', 'bad-image');
        }

        const key = randomUUID();
        const names = imageFileNames(key);
        await storage.put(names.full, full, 'image/webp');
        await storage.put(names.thumb, thumb, 'image/webp');
        return reply.code(201).send({
          imageKey: key,
          imageUrl: storage.publicUrl(names.full),
          thumbUrl: storage.publicUrl(names.thumb),
        });
      },
    );
  };
