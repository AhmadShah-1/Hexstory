import sharp from 'sharp';

/**
 * Decodes an image and re-encodes it as WebP: a full size (at most 1600 px) and a 160 px thumbnail.
 * Re-encoding strips EXIF/GPS metadata and rejects anything that isn't a real image. Used for
 * uploads and imports alike. Throws if the file can't be read as an image.
 */
const FORMATS = new Set(['jpeg', 'png', 'webp']);

export async function encodeImage(original: Buffer): Promise<{ full: Buffer; thumb: Buffer }> {
  const input = sharp(original, { limitInputPixels: 50_000_000 });
  // sharp also decodes SVG, TIFF, GIF and more; accept only what the upload form promises.
  const { format } = await input.metadata();
  if (!format || !FORMATS.has(format)) throw new Error('Use a JPEG, PNG or WebP image');
  const image = input.rotate();
  const full = await image.clone().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await image.clone().resize(160, 160, { fit: 'cover', position: 'attention' }).webp({ quality: 75 }).toBuffer();
  return { full, thumb };
}
