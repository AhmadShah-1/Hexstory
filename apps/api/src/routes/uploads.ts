import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { LIMITS, uploadIntentSchema, type UploadTicket, type UploadedImage } from '@hexstory/shared';
import { HttpError, badRequest, notFound } from '../errors.js';
import { parse, requireWriter } from '../http.js';
import { POLICY } from '../policy.js';
import { claimUpload, hasOpenUpload, recordStoredUpload, releaseUpload, reserveUpload } from '../services/uploads.js';
import { imageFileNames, stagedKey } from '../storage/index.js';
import type { Deps } from './deps.js';

const TOO_LARGE = 'Images must be smaller than 6 MB.';
const idParams = z.object({ id: z.uuid() });

/**
 * Uploading an image takes three steps, so originals up to LIMITS.imageBytesMax never pass through
 * a Vercel Function (whose request bodies are capped at 4.5 MB):
 *
 *   1. POST /api/uploads {size}            -> an upload id and a pre-signed PUT URL for that size
 *   2. PUT <url> (the original, from the browser straight to private staging storage)
 *   3. POST /api/uploads/:id/complete       -> the API reads the original, re-encodes it, publishes it
 *
 * Images are always re-encoded: this strips EXIF (including GPS location, which matters for photos
 * of protests), normalises orientation, and guarantees we only ever serve real WebP images.
 * Originals are never public.
 */
export const uploadRoutes =
  ({ sql, storage }: Deps): FastifyPluginAsync =>
  async (app) => {
    const perUser = (max: number) => ({
      rateLimit: { max, timeWindow: '1 hour', keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip },
    });

    app.post('/api/uploads', { config: perUser(POLICY.uploadsPerHour) }, async (req, reply) => {
      const user = requireWriter(req);
      const { size } = parse(uploadIntentSchema, req.body);
      const id = randomUUID();
      // Daily quota per user (count and size), on top of the hourly rate limit.
      await reserveUpload(sql, user, id, size);
      const ticket: UploadTicket = { id, upload: await storage.stagingTarget(stagedKey(user.id, id), size) };
      return reply.code(201).send(ticket);
    });

    if (storage.writeStaged) {
      // Local development only: stands in for the pre-signed bucket URL.
      app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: LIMITS.imageBytesMax }, (_req, body, done) =>
        done(null, body),
      );
      app.put('/api/uploads/:id/original', { bodyLimit: LIMITS.imageBytesMax }, async (req, reply) => {
        const user = requireWriter(req);
        const { id } = parse(idParams, req.params);
        if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as application/octet-stream.');
        // Only into a slot this user reserved and hasn't completed, like a pre-signed URL.
        if (!(await hasOpenUpload(sql, user.id, id))) throw notFound('That upload');
        await storage.writeStaged!(stagedKey(user.id, id), req.body);
        return reply.code(200).send();
      });
    }

    app.post('/api/uploads/:id/complete', { config: perUser(POLICY.uploadsPerHour * 2) }, async (req, reply) => {
      const user = requireWriter(req);
      const { id } = parse(idParams, req.params);
      // The key is built from the session, so nobody can complete someone else's upload.
      const key = stagedKey(user.id, id);
      if (!(await claimUpload(sql, user.id, id))) throw notFound('That upload');
      const original = await storage.readStaged(key, LIMITS.imageBytesMax).catch(async (err) => {
        await releaseUpload(sql, user.id, id);
        throw err;
      });
      if (original === 'missing') {
        // Not uploaded yet (or already gone): the slot stays usable until the browser sends it.
        await releaseUpload(sql, user.id, id);
        throw notFound('That upload');
      }
      const discardOriginal = () => storage.deleteStaged(key).catch((err) => req.log.warn({ err }, 'could not delete staged upload'));
      if (original === 'too-large') {
        await discardOriginal();
        throw badRequest(TOO_LARGE, 'too-large');
      }

      let full: Buffer, thumb: Buffer;
      try {
        const image = sharp(original, { limitInputPixels: 50_000_000 }).rotate();
        full = await image.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        thumb = await image.clone().resize(160, 160, { fit: 'cover', position: 'attention' }).webp({ quality: 75 }).toBuffer();
      } catch {
        await discardOriginal();
        throw badRequest('That file is not an image we can read. Try a JPEG, PNG or WebP.', 'bad-image');
      }

      const names = imageFileNames(id);
      try {
        await Promise.all([storage.put(names.full, full, 'image/webp'), storage.put(names.thumb, thumb, 'image/webp')]);
      } catch (err) {
        // Never leave half an image behind or report it as uploaded. The original stays staged,
        // so the browser can retry this step.
        req.log.error({ err }, 'publishing image failed');
        await Promise.allSettled([storage.delete(names.full), storage.delete(names.thumb)]);
        await releaseUpload(sql, user.id, id);
        throw new HttpError(502, 'storage', 'The image could not be saved. Please try again.');
      }
      await discardOriginal();
      await recordStoredUpload(sql, user.id, id, full.length + thumb.length);

      const result: UploadedImage = {
        imageKey: id,
        imageUrl: storage.publicUrl(names.full),
        thumbUrl: storage.publicUrl(names.thumb),
      };
      return reply.code(201).send(result);
    });
  };
